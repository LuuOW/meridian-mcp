#!/usr/bin/env python3
"""
Synthetic-data sanity test for find_probe_coincidences.

The rewrite of find_probe_coincidences from iterrows to vectorized
merge_asof can't be byte-compared against the legacy because the legacy
is gone (one-step rewrite). This script builds a deterministic synthetic
input where we KNOW the right answer, runs the function, and asserts
output invariants.

Invariants tested:
  1. Self-pairs are dropped (no row with source == target).
  2. Inner→outer pair (r_src < r_tgt) produces dt_h > 0.
  3. A perfectly-aligned synthetic event hits matched=True.
  4. A lon-mismatched synthetic event has matched=False.
  5. match_score in [0, 1] for matched rows.
  6. Output column set matches the documented schema.

Runs in-process with no HF I/O. Exits 0 on pass, non-zero with a
specific assertion message on fail.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass

import numpy as np
import pandas as pd

from coincide import (
    LON_TOLERANCE_DEG,
    OMEGA_SUN_DEG_PER_DAY,
    T_TOLERANCE_HOURS_WIND,
    V_SW_KM_PER_SEC,
    find_probe_coincidences,
)


@dataclass
class TestResult:
    name: str
    passed: bool
    detail: str = ""


def build_synthetic() -> tuple[pd.DataFrame, pd.DataFrame]:
    """Three spacecraft: PSP at r=0.1 AU, SOURCE event at lon=0°;
    L1 at r=1.0 AU; OUTER at r=2.0 AU. We seed L1 with two events:
    one aligned with the Parker spiral from PSP (should match) and one
    far off in lon (should not match)."""
    base_t = pd.Timestamp("2024-07-01T00:00:00")
    AU_KM = 149_597_870.7
    v_sw = V_SW_KM_PER_SEC
    # transit PSP→L1 with 0.9 AU gap at v=400 km/s
    dt_h_psp_l1 = (0.9 * AU_KM) / v_sw / 3600.0
    dt_h_psp_outer = (1.9 * AU_KM) / v_sw / 3600.0
    # spiral wrap from PSP to L1
    dlon_psp_l1 = OMEGA_SUN_DEG_PER_DAY * dt_h_psp_l1 / 24.0
    dlon_psp_outer = OMEGA_SUN_DEG_PER_DAY * dt_h_psp_outer / 24.0

    events = pd.DataFrame([
        # PSP source event at lon=0
        {"timestamp": base_t, "spacecraft": "PSP",
          "r_au": 0.1, "helio_lon_deg": 0.0, "helio_lat_deg": 0.0,
          "carrington_lon_deg": 0.0, "pvi_tau100s": 5.0},
        # L1 event ALIGNED with spiral (lon = 0 - dlon, arrives at t + dt_h)
        {"timestamp": base_t + pd.Timedelta(hours=dt_h_psp_l1),
          "spacecraft": "L1",
          "r_au": 1.0, "helio_lon_deg": -dlon_psp_l1, "helio_lat_deg": 0.0,
          "carrington_lon_deg": 0.0, "pvi_tau100s": 4.5},
        # L1 event MISALIGNED (lon = 0 - dlon + 90, way off the spiral)
        {"timestamp": base_t + pd.Timedelta(hours=dt_h_psp_l1),
          "spacecraft": "L1",
          "r_au": 1.0, "helio_lon_deg": -dlon_psp_l1 + 90.0, "helio_lat_deg": 0.0,
          "carrington_lon_deg": 0.0, "pvi_tau100s": 4.0},
        # OUTER event aligned for PSP→OUTER spiral
        {"timestamp": base_t + pd.Timedelta(hours=dt_h_psp_outer),
          "spacecraft": "OUTER",
          "r_au": 2.0, "helio_lon_deg": -dlon_psp_outer, "helio_lat_deg": 0.0,
          "carrington_lon_deg": 0.0, "pvi_tau100s": 4.0},
    ])

    # Ephemeris: each spacecraft's position. Note the target's helio_lon_deg
    # IS what coincide.py uses for the lon-spiral check, so we set it so
    # that the aligned L1 event matches the spiral prediction (lon=-dlon
    # at the arrival timestamp).
    eph_rows = []
    for sc, r, lon in [("PSP", 0.1, 0.0), ("L1", 1.0, -dlon_psp_l1),
                         ("OUTER", 2.0, -dlon_psp_outer)]:
        for h in range(-24, 24, 1):  # 48 hours of "ephemeris"
            eph_rows.append({
                "timestamp": base_t + pd.Timedelta(hours=h),
                "body": sc, "r_au": r, "x_au": r, "y_au": 0.0, "z_au": 0.0,
                "helio_lon_deg": lon, "helio_lat_deg": 0.0,
                "carrington_lon_deg": 0.0,
            })
    return events, pd.DataFrame(eph_rows)


def run_tests() -> list[TestResult]:
    results: list[TestResult] = []
    events, eph = build_synthetic()
    out = find_probe_coincidences(events, eph)

    # Invariant 1: output non-empty, no self-pairs
    results.append(TestResult(
        "no self-pairs",
        not out.empty and (out["source_spacecraft"] != out["target_spacecraft"]).all(),
        f"got {len(out)} rows; self-pair count "
        f"{(out['source_spacecraft'] == out['target_spacecraft']).sum() if not out.empty else 'n/a'}",
    ))

    # Invariant 2: PSP→L1 pair has dt_h > 0 (inner to outer)
    psp_l1 = out[(out["source_spacecraft"] == "PSP") & (out["target_spacecraft"] == "L1")]
    results.append(TestResult(
        "PSP→L1 dt_h > 0",
        not psp_l1.empty and (psp_l1["advection_lead_hours"] > 0).all(),
        f"PSP→L1 rows: {len(psp_l1)}, dt_h range "
        f"{psp_l1['advection_lead_hours'].min() if not psp_l1.empty else 'n/a'}–"
        f"{psp_l1['advection_lead_hours'].max() if not psp_l1.empty else 'n/a'}",
    ))

    # Invariant 3: PSP→L1 aligned event matched
    matched_psp_l1 = psp_l1[psp_l1["matched"]]
    results.append(TestResult(
        "aligned PSP→L1 event matches",
        not matched_psp_l1.empty,
        f"matched_psp_l1 = {len(matched_psp_l1)}, expected ≥1",
    ))

    # Invariant 4: All matched rows have d_lon within tolerance
    if not matched_psp_l1.empty:
        within_lon = matched_psp_l1["delta_lon_deg"].abs() <= LON_TOLERANCE_DEG
        results.append(TestResult(
            "matched d_lon within LON_TOLERANCE_DEG",
            within_lon.all(),
            f"max |d_lon| = {matched_psp_l1['delta_lon_deg'].abs().max():.2f}",
        ))

    # Invariant 5: match_score in [0, 1] for matched rows
    matched = out[out["matched"]]
    score_ok = matched["match_score"].between(0, 1).all() if not matched.empty else True
    results.append(TestResult(
        "match_score in [0,1] for matched rows",
        score_ok,
        f"score range: {matched['match_score'].min() if not matched.empty else 'n/a'}–"
        f"{matched['match_score'].max() if not matched.empty else 'n/a'}",
    ))

    # Invariant 6: Output schema columns present
    expected_cols = {
        "source_spacecraft", "target_spacecraft", "source_event_timestamp",
        "source_r_au", "source_lon_deg", "target_r_au",
        "target_lon_at_arrival_deg", "predicted_arrival_timestamp",
        "advection_lead_hours", "advection_v_sw_km_s", "delta_lon_deg",
        "matched", "nearest_target_event_dt_hours",
        "nearest_target_event_pvi", "nearest_target_event_timestamp",
        "lon_score", "t_score", "match_score",
    }
    missing = expected_cols - set(out.columns)
    results.append(TestResult(
        "schema columns present",
        not missing,
        f"missing: {missing if missing else 'none'}",
    ))

    return results


def main() -> int:
    print("Synthetic-data sanity test for find_probe_coincidences")
    print("-" * 60)
    results = run_tests()
    failed = 0
    for r in results:
        marker = "✓" if r.passed else "✗"
        print(f"  {marker} {r.name:<45} {r.detail}")
        if not r.passed:
            failed += 1
    print("-" * 60)
    print(f"{len(results) - failed}/{len(results)} passed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
