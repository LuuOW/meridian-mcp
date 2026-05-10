#!/usr/bin/env python3
"""
Stage 4 — synthetic harvester ground truth.

For every PSP feature window, compute the heliocentric distance r_AU using a
simple Kepler orbit anchored on each encounter's perihelion, then derive
irradiance (1361 W/m² at 1 AU, scaled by 1/r²) and the harvested power
density E_harvest_W_m2 = η · irradiance, where η is the multi-junction PV
cell efficiency (Spectrolab XTJ Prime ≈ 0.30).

This is the ground truth stages 5–6 train and evaluate against. The model
is purely geometric — magnetic field activity does not physically reduce
sunlight at the panels. The bet is that the (λ, φ, p, a, τ_c) features
implicitly track distance well enough for archetype-routed specialists to
beat persistence at predicting E_harvest(t+Δ) over horizons where r changes.

Output: harvest/E_truth.parquet pushed to the HF dataset, joined onto the
features by win_start.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from huggingface_hub import HfApi, hf_hub_download

REPO_ID = "luuow/meridian-stellar-cache"
FEATURES_FILE = "features/psp_features.parquet"

# Approximate perihelion epochs for PSP encounters in the cached date range.
# Sub-hour error in t_peri propagates to <2% error in r_AU at perihelion —
# fine for the harvester baseline.
PERIHELION_TIMES = {
    "E20": pd.Timestamp("2024-06-30 04:00:00"),
    "E21": pd.Timestamp("2024-09-30 14:00:00"),
    "E22": pd.Timestamp("2024-12-24 11:00:00"),
    "E23": pd.Timestamp("2025-03-22 22:00:00"),
    "E24": pd.Timestamp("2025-06-19 18:00:00"),
}

# PSP orbit constants for the 5th–7th orbit family (post-Venus-flyby 2023).
SEMI_MAJOR_AU = 0.388
ECCENTRICITY = 0.881
PERIOD_DAYS = 88.0

# Physical constants for the harvester.
PV_EFFICIENCY = 0.30        # Multi-junction (Spectrolab XTJ Prime triple-junction)
SOLAR_CONSTANT = 1361.0     # W/m² at 1 AU


def solve_kepler(M: np.ndarray, e: float, n_iter: int = 30) -> np.ndarray:
    """Newton-Raphson on E - e*sin(E) = M."""
    E = np.where(np.abs(M) < np.pi, M, np.pi)
    for _ in range(n_iter):
        E = E - (E - e * np.sin(E) - M) / (1.0 - e * np.cos(E))
    return E


def closest_perihelion(t: pd.Timestamp) -> tuple[str, pd.Timestamp]:
    best_name, best_t, best_dt = None, None, None
    for name, peri_t in PERIHELION_TIMES.items():
        dt = abs((t - peri_t).total_seconds())
        if best_dt is None or dt < best_dt:
            best_name, best_t, best_dt = name, peri_t, dt
    return best_name, best_t


def heliocentric_distance(t: pd.Timestamp, peri_t: pd.Timestamp) -> float:
    dt_days = (t - peri_t).total_seconds() / 86400.0
    M = 2.0 * np.pi * dt_days / PERIOD_DAYS
    M = ((M + np.pi) % (2.0 * np.pi)) - np.pi  # wrap to [-π, π]
    E = solve_kepler(np.array([M]), ECCENTRICITY)[0]
    return float(SEMI_MAJOR_AU * (1.0 - ECCENTRICITY * np.cos(E)))


def main() -> int:
    if "HF_TOKEN" not in os.environ:
        print("ERROR: HF_TOKEN not set", file=sys.stderr)
        return 1
    token = os.environ["HF_TOKEN"]

    feat_path = hf_hub_download(
        repo_id=REPO_ID, repo_type="dataset", filename=FEATURES_FILE, token=token
    )
    df = pd.read_parquet(feat_path)
    print(f"[stage-4] loaded {len(df)} feature rows")

    perihelions = []
    r_au = np.empty(len(df))
    for i, t in enumerate(df["win_start"]):
        ts = pd.Timestamp(t)
        if ts.tzinfo is not None:
            ts = ts.tz_convert(None).tz_localize(None)
        peri_name, peri_t = closest_perihelion(ts)
        perihelions.append(peri_name)
        r_au[i] = heliocentric_distance(ts, peri_t)

    irradiance = SOLAR_CONSTANT / (r_au ** 2)
    E_harvest = PV_EFFICIENCY * irradiance

    df_out = df.copy()
    df_out["perihelion"] = perihelions
    df_out["r_AU"] = r_au
    df_out["irradiance_W_m2"] = irradiance
    df_out["E_harvest_W_m2"] = E_harvest

    print(f"\n[stage-4] r_AU summary by perihelion:")
    print(df_out.groupby("perihelion")["r_AU"].describe()[["count", "min", "50%", "max"]].to_string())

    print(f"\n[stage-4] E_harvest summary (W/m²):")
    print(df_out["E_harvest_W_m2"].describe().to_string())
    print(f"\n[stage-4] log10 E_harvest range: {np.log10(df_out.E_harvest_W_m2.min()):.2f} → {np.log10(df_out.E_harvest_W_m2.max()):.2f}")

    out_dir = Path("stellar_cache/harvest")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "E_truth.parquet"
    df_out.to_parquet(out_path, compression="snappy")
    print(f"[stage-4] wrote {out_path}")

    api = HfApi(token=token)
    api.upload_file(
        path_or_fileobj=str(out_path),
        path_in_repo="harvest/E_truth.parquet",
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message="stage-4: synthetic harvester ground truth (E_harvest_W_m2)",
    )
    print(f"[stage-4] pushed harvest/E_truth.parquet to https://huggingface.co/datasets/{REPO_ID}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
