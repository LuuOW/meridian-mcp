#!/usr/bin/env python3
"""
Stage 4-tight — physics-aware tolerance bands for probe-pair coincidences.

Stage 4 uses constant ±20° / ±24 h regardless of the source-target geometry,
which is why 95% of ACE↔DSCOVR pair candidates match (they're <1 km apart)
while many PSP↔outer probe pairs miss for the wrong reason (Parker spiral
longitude wraps faster than 20° in 1+ day transits).

This stage replaces the constants with bands scaled by predicted Parker
transit time dt_h = (r_tgt - r_src) * AU / v_sw / 3600:

  dt_h  <  1 h:  t_tol = 0.5 h, lon_tol = 5°    (L1↔L1)
  1  ≤ dt_h < 6:  t_tol = 2 h,  lon_tol = 10°   (STEREO-A↔L1)
  6  ≤ dt_h < 24: t_tol = 8 h,  lon_tol = 12°
  dt_h ≥ 24 h:   t_tol = dt_h*0.5, lon_tol = 15° (PSP↔outer)

Result: fewer but more meaningful matches; median match score should
rise from 0.29 toward 0.6+. The original stage-4 output is preserved
unchanged so the 979-match claim stays reproducible.

Output:
  events/probe_coincidences_tight_{P}.parquet
  events/probe_coincidences_summary_tight_{P}.json
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from huggingface_hub import HfApi, hf_hub_download, list_repo_files

from coincide import (
    AU_KM, OMEGA_SUN_DEG_PER_DAY, V_SW_KM_PER_SEC,
    attach_per_event_vsw, load_all_plasma, target_vsw_at, wrap_180,
)
from gates import Gate
from targets import PERIHELIA

REPO_ID = "luuow/meridian-helio-mirror"
PERIHELION = os.environ.get("HELIO_PERIHELION", "E20")


def per_pair_tolerance(dt_h: float) -> tuple[float, float]:
    """Returns (t_tolerance_hours, lon_tolerance_degrees) given predicted
    Parker transit time between source and target spacecraft."""
    if dt_h < 1.0:
        return 0.5, 5.0
    if dt_h < 6.0:
        return 2.0, 10.0
    if dt_h < 24.0:
        return 8.0, 12.0
    return dt_h * 0.5, 15.0


def load(token: str, name: str) -> pd.DataFrame:
    files = list_repo_files(REPO_ID, repo_type="dataset", token=token)
    if name not in files:
        return pd.DataFrame()
    p = hf_hub_download(repo_id=REPO_ID, repo_type="dataset",
                        filename=name, token=token)
    return pd.read_parquet(p)


def find_tight(events: pd.DataFrame, eph_long: pd.DataFrame,
                plasma_by_sc: dict[str, pd.DataFrame] | None = None) -> pd.DataFrame:
    """Same v_sw model as the loose find_probe_coincidences: source+target
    average via plasma_by_sc, fall back to event row v_sw, fall back to
    V_SW_KM_PER_SEC constant. Without this the 'tight' track was at
    constant v=400 while 'loose' uses averaging — inconsistent."""
    if events.empty:
        return pd.DataFrame()
    spacecrafts = events["spacecraft"].dropna().unique().tolist()
    if len(spacecrafts) < 2:
        return pd.DataFrame()
    events = events.dropna(subset=["r_au", "helio_lon_deg", "spacecraft"]).copy()
    events["timestamp"] = pd.to_datetime(events["timestamp"]).dt.tz_localize(None)
    has_per_event_vsw = "v_sw_km_s" in events.columns

    rows: list[dict] = []
    for src in spacecrafts:
        src_events = events[events["spacecraft"] == src]
        if src_events.empty:
            continue
        for tgt in spacecrafts:
            if tgt == src:
                continue
            tgt_eph = eph_long[eph_long["body"] == tgt].sort_values("timestamp")
            tgt_events = events[events["spacecraft"] == tgt].sort_values("timestamp")
            if tgt_eph.empty:
                continue
            for _, ev in src_events.iterrows():
                r_src = float(ev["r_au"])
                t_src = pd.Timestamp(ev["timestamp"])
                lon_src = float(ev["helio_lon_deg"])
                v_src = (float(ev["v_sw_km_s"])
                          if has_per_event_vsw and pd.notna(ev.get("v_sw_km_s"))
                          else V_SW_KM_PER_SEC)
                idx = (tgt_eph["timestamp"] - t_src).abs().idxmin()
                r_tgt = float(tgt_eph.loc[idx, "r_au"])
                if not np.isfinite(r_src) or not np.isfinite(r_tgt):
                    continue
                dr_km = (r_tgt - r_src) * AU_KM
                # First-pass dt with source v_sw; then look up target v_sw
                # at predicted arrival and average.
                dt_h_first = dr_km / v_src / 3600.0
                if dt_h_first < 0:
                    continue
                if plasma_by_sc is not None and tgt in plasma_by_sc:
                    v_tgt_series = target_vsw_at(plasma_by_sc, tgt,
                                                    pd.Series([t_src + pd.Timedelta(hours=dt_h_first)]))
                    v_tgt = float(v_tgt_series.iloc[0]) if not v_tgt_series.empty else float("nan")
                else:
                    v_tgt = float("nan")
                v_avg = (v_src + v_tgt) / 2.0 if np.isfinite(v_tgt) else v_src
                dt_h = dr_km / v_avg / 3600.0
                t_tol, lon_tol = per_pair_tolerance(dt_h)
                t_arrival = t_src + pd.Timedelta(hours=dt_h)
                lon_tgt_at_arr = float(
                    tgt_eph.loc[(tgt_eph["timestamp"] - t_arrival).abs().idxmin(),
                                 "helio_lon_deg"])
                lon_src_advected = lon_src - OMEGA_SUN_DEG_PER_DAY * dt_h / 24.0
                d_lon = float(wrap_180(np.array([lon_src_advected - lon_tgt_at_arr]))[0])
                if abs(d_lon) > lon_tol:
                    continue
                if tgt_events.empty:
                    matched = False
                    nearest_dt_h = np.nan
                    nearest_peak_pvi = np.nan
                    nearest_event_ts = None
                else:
                    deltas = (tgt_events["timestamp"] - t_arrival).dt.total_seconds() / 3600.0
                    idx_n = deltas.abs().idxmin()
                    nearest_dt_h = float(deltas.loc[idx_n])
                    matched = abs(nearest_dt_h) <= t_tol
                    nearest_peak_pvi = (float(tgt_events.loc[idx_n, "pvi_tau100s"])
                                         if "pvi_tau100s" in tgt_events.columns else np.nan)
                    nearest_event_ts = pd.Timestamp(tgt_events.loc[idx_n, "timestamp"])
                rows.append({
                    "source_spacecraft": src,
                    "target_spacecraft": tgt,
                    "source_event_timestamp": t_src,
                    "source_event_pvi": float(ev.get("pvi_tau100s", np.nan)),
                    "source_r_au": r_src, "source_lon_deg": lon_src,
                    "target_r_au": r_tgt, "target_lon_at_arrival_deg": lon_tgt_at_arr,
                    "predicted_arrival_timestamp": t_arrival,
                    "advection_lead_hours": dt_h,
                    "advection_v_sw_km_s": v_avg,
                    "delta_lon_deg": d_lon,
                    "t_tolerance_hours": t_tol,
                    "lon_tolerance_deg": lon_tol,
                    "matched": matched,
                    "nearest_target_event_dt_hours": nearest_dt_h,
                    "nearest_target_event_pvi": nearest_peak_pvi,
                    "nearest_target_event_timestamp": nearest_event_ts,
                })
    out = pd.DataFrame(rows)
    if out.empty:
        return out
    out["lon_score"] = 1.0 - out["delta_lon_deg"].abs() / out["lon_tolerance_deg"]
    out["t_score"] = (1.0 - out["nearest_target_event_dt_hours"].abs() / out["t_tolerance_hours"]).clip(0, 1)
    out["match_score"] = (out["lon_score"] * out["t_score"]).where(out["matched"], 0.0)
    return out


def main() -> int:
    if "HF_TOKEN" not in os.environ:
        print("ERROR: HF_TOKEN not set", file=sys.stderr)
        return 1
    token = os.environ["HF_TOKEN"]
    api = HfApi(token=token)
    if PERIHELION not in PERIHELIA:
        print(f"ERROR: unknown perihelion {PERIHELION}", file=sys.stderr)
        return 1

    with Gate("coincide_tight", PERIHELION, REPO_ID, api=api) as gate:
        rc = _main_inner(token, api, gate)
    return rc


def _main_inner(token: str, api: HfApi, gate: Gate) -> int:
    psp_events = load(token, f"events/psp_candidate_events_{PERIHELION}.parquet")
    probe_events = load(token, f"events/probe_candidate_events_{PERIHELION}.parquet")
    eph_long = load(token, f"coords/ephemeris_long_{PERIHELION}.parquet")
    if eph_long.empty or (psp_events.empty and probe_events.empty):
        print(f"[coincide_tight] missing inputs for {PERIHELION}", file=sys.stderr)
        gate.ok = False
        gate.reason = "missing inputs"
        return 1

    if not psp_events.empty:
        psp_events = psp_events.copy()
        psp_events["spacecraft"] = "PSP"
    if not probe_events.empty:
        probe_events = probe_events.copy()
    parts = [df for df in (psp_events, probe_events) if not df.empty]
    events = pd.concat(parts, ignore_index=True)
    events = events.dropna(subset=["spacecraft", "r_au", "helio_lon_deg"])
    eph_long = eph_long.copy()
    eph_long["timestamp"] = pd.to_datetime(eph_long["timestamp"]).dt.tz_localize(None)

    # Same v_sw model as loose stage 4 (otherwise this 'tight' track is
    # at constant v=400 while the loose track averages plasma — apples vs
    # oranges).
    events = attach_per_event_vsw(events, token)
    plasma_by_sc = load_all_plasma(token)
    out = find_tight(events, eph_long, plasma_by_sc)
    matched = (out[out["matched"]] if not out.empty else pd.DataFrame())
    n_matched = int(len(matched))
    n_total = int(len(out))
    median_score = (float(matched["match_score"].median())
                     if not matched.empty else None)

    score_str = f"{median_score:.3f}" if median_score is not None else "n/a"
    print(f"[coincide_tight] {PERIHELION}: {n_matched} matched / {n_total} candidate pairs "
          f"(median match score {score_str})")

    out_dir = Path("helio_cache/events")
    out_dir.mkdir(parents=True, exist_ok=True)
    if not out.empty:
        out.to_parquet(out_dir / f"probe_coincidences_tight_{PERIHELION}.parquet",
                        compression="snappy")
    pair_breakdown = (
        matched.groupby(["source_spacecraft", "target_spacecraft"])
        .agg(n=("matched", "sum"),
              median_score=("match_score", "median"),
              median_lon_dev=("delta_lon_deg", lambda s: float(s.abs().median())),
              median_dt_dev=("nearest_target_event_dt_hours",
                              lambda s: float(s.abs().median())))
        .reset_index()
        .to_dict(orient="records")
    ) if not matched.empty else []
    summary = {
        "perihelion": PERIHELION,
        "tolerance_mode": "per_pair_physics_aware",
        "n_candidate_pairs": n_total,
        "n_matched_pairs": n_matched,
        "median_match_score": median_score,
        "pair_breakdown": pair_breakdown,
        "comparison_to_stage4": (
            "Stage 4 uses constant ±20°/±24h and matched 979 with median score 0.29 "
            "on E20. This stage uses physics-aware bands — expect fewer matches "
            "but higher per-match confidence."
        ),
    }
    summary_path = out_dir / f"probe_coincidences_summary_tight_{PERIHELION}.json"
    summary_path.write_text(json.dumps(summary, indent=2, default=str))

    from hf_push import push_folder
    push_folder(api, REPO_ID, out_dir, "events",
                 f"stage-4-tight: physics-aware probe coincidences {PERIHELION}",
                 allow_patterns=[f"probe_coincidences_tight_{PERIHELION}.parquet",
                                  f"probe_coincidences_summary_tight_{PERIHELION}.json"])
    gate.n_inputs = int(len(events))
    gate.n_outputs = n_matched
    gate.notes = {
        "n_candidate_pairs": n_total,
        "n_matched_pairs": n_matched,
        "median_match_score": median_score,
        "n_pairs_in_breakdown": len(pair_breakdown),
    }
    if n_matched == 0:
        gate.reason = "no pairs passed tight tolerances — consider relaxing or check inputs"
    return 0


if __name__ == "__main__":
    sys.exit(main())
