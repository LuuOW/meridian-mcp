#!/usr/bin/env python3
"""
Stage 5 + 6 — train per-archetype specialists and evaluate vs persistence.

Pipeline:
  1. Join features + archetype labels + harvester ground truth on win_start.
  2. Build (t, t+Δ) pairs *within* each perihelion's continuous window.
  3. Split by perihelion: train on E20–E23, hold out E24.
  4. Stage 5 — per-cluster Ridge regression on (λ, φ, p, a, τ_c)_t → log10 E_{t+Δ}.
     Skip clusters with too few train pairs (singleton handling).
  5. Stage 6 — race three policies on the holdout:
        (a) fixed   = global mean of log10 E_train
        (b) persist = log10 E_t (r unchanged assumption)
        (c) archetype = route to the cluster's specialist
     Score MAE in log10 space + linear MAE in W/m².
  6. Gate-2: archetype must beat persistence by >3 % MAE.

Outputs to HF Dataset:
  specialists/specialists.json — model weights, scaler, training meta
  evaluation/results.json     — full metric table + Gate-2 verdict
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from huggingface_hub import HfApi, hf_hub_download
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler

REPO_ID = "luuow/meridian-stellar-cache"
FORECAST_HORIZON_HOURS = 24
PAIR_TOLERANCE_SECONDS = 1800  # ±30 min match window
MIN_TRAIN_PER_CLUSTER = 10
TRAIN_PERIHELIA = {"E20", "E21", "E22", "E23"}
TEST_PERIHELIA = {"E24"}
FEATURE_COLS = ["lambda_peak_hz", "phi_entropy", "p_polarization", "a_amplitude", "tau_c_sec"]
RIDGE_ALPHA = 1.0


def grab(filename: str, token: str) -> str:
    return hf_hub_download(repo_id=REPO_ID, repo_type="dataset", filename=filename, token=token)


def build_pairs(df: pd.DataFrame, horizon_hours: int) -> pd.DataFrame:
    """Create (t, t+Δ) pairs within each perihelion's continuous time block."""
    horizon_s = horizon_hours * 3600
    rows: list[dict] = []
    df = df.copy()
    df["t_s"] = df["win_start"].astype("int64") / 1e9

    for peri, g in df.groupby("perihelion"):
        g = g.sort_values("t_s").reset_index(drop=True)
        t = g["t_s"].to_numpy()
        for i in range(len(g)):
            target = t[i] + horizon_s
            diffs = np.abs(t - target)
            j = int(diffs.argmin())
            if diffs[j] > PAIR_TOLERANCE_SECONDS or j == i:
                continue
            rows.append(
                {
                    "perihelion": peri,
                    "win_start_now": g["win_start"].iloc[i],
                    "win_start_future": g["win_start"].iloc[j],
                    "cluster": int(g["cluster"].iloc[i]),
                    **{c: float(g[c].iloc[i]) for c in FEATURE_COLS},
                    "E_now": float(g["E_harvest_W_m2"].iloc[i]),
                    "E_future": float(g["E_harvest_W_m2"].iloc[j]),
                    "r_now": float(g["r_AU"].iloc[i]),
                    "r_future": float(g["r_AU"].iloc[j]),
                }
            )
    return pd.DataFrame(rows)


def main() -> int:
    if "HF_TOKEN" not in os.environ:
        print("ERROR: HF_TOKEN not set", file=sys.stderr)
        return 1
    token = os.environ["HF_TOKEN"]

    print("[stage-5] loading harvest + labels")
    df_e = pd.read_parquet(grab("harvest/E_truth.parquet", token))
    df_lbl = pd.read_parquet(grab("archetypes/labels.parquet", token))[["win_start", "cluster"]]
    df = df_e.merge(df_lbl, on="win_start", how="inner")
    df["cluster"] = df["cluster"].astype(int)
    print(f"[stage-5] joined rows: {len(df)}")

    pairs = build_pairs(df, FORECAST_HORIZON_HOURS)
    print(f"[stage-5] {FORECAST_HORIZON_HOURS}h pairs: {len(pairs)}")
    print(f"[stage-5] per-perihelion pair counts:")
    print(pairs["perihelion"].value_counts().sort_index().to_string())

    train = pairs[pairs["perihelion"].isin(TRAIN_PERIHELIA)].reset_index(drop=True)
    test = pairs[pairs["perihelion"].isin(TEST_PERIHELIA)].reset_index(drop=True)
    print(f"\n[stage-5] train pairs: {len(train)}  test pairs: {len(test)}")
    if len(test) == 0 or len(train) == 0:
        print("ERROR: empty train or test set", file=sys.stderr)
        return 1

    scaler = StandardScaler()
    X_train = scaler.fit_transform(train[FEATURE_COLS].to_numpy())
    X_test = scaler.transform(test[FEATURE_COLS].to_numpy())
    y_train = np.log10(train["E_future"].to_numpy())
    y_test = np.log10(test["E_future"].to_numpy())

    print(f"\n[stage-5] training Ridge specialists per cluster")
    specialists: dict[int, dict] = {}
    for c in sorted(train["cluster"].unique()):
        mask = train["cluster"].to_numpy() == c
        n = int(mask.sum())
        if n < MIN_TRAIN_PER_CLUSTER:
            print(f"[stage-5]   cluster {c}: only {n} pairs — skipping (will fall back to global mean)")
            continue
        Xc = X_train[mask]
        yc = y_train[mask]
        ridge = Ridge(alpha=RIDGE_ALPHA)
        ridge.fit(Xc, yc)
        residuals = ridge.predict(Xc) - yc
        specialists[int(c)] = {
            "type": "ridge",
            "coef": ridge.coef_.tolist(),
            "intercept": float(ridge.intercept_),
            "n_train": n,
            "rmse_train_log10": float(np.sqrt(np.mean(residuals ** 2))),
            "y_mean_log10": float(np.mean(yc)),
        }
        print(f"[stage-5]   cluster {c}: n={n}  RMSE_train_log10={specialists[c]['rmse_train_log10']:.4f}")

    print(f"\n[stage-6] === policy race on holdout E24 (n={len(test)}) ===")

    fixed_pred = np.full(len(test), float(np.mean(y_train)))
    persist_pred = np.log10(test["E_now"].to_numpy())
    archetype_pred = np.empty(len(test))
    fallback_count = 0
    for i in range(len(test)):
        c = int(test["cluster"].iloc[i])
        spec = specialists.get(c)
        if spec is None:
            archetype_pred[i] = float(np.mean(y_train))
            fallback_count += 1
        else:
            archetype_pred[i] = float(np.array(spec["coef"]) @ X_test[i] + spec["intercept"])
    if fallback_count:
        print(f"[stage-6] (note: {fallback_count} test rows fell back to global mean — cluster had no specialist)")

    def mae_log(p): return float(np.mean(np.abs(p - y_test)))
    def mae_lin(p): return float(np.mean(np.abs(10 ** p - 10 ** y_test)))

    results = {
        "horizon_hours": FORECAST_HORIZON_HOURS,
        "metric_primary": "MAE in log10(E_W_m2)",
        "n_train_pairs": int(len(train)),
        "n_test_pairs": int(len(test)),
        "specialists_trained": [int(c) for c in specialists.keys()],
        "fallback_test_rows": int(fallback_count),
        "policies": {
            "fixed":     {"mae_log10": mae_log(fixed_pred),     "mae_W_m2": mae_lin(fixed_pred)},
            "persistence": {"mae_log10": mae_log(persist_pred), "mae_W_m2": mae_lin(persist_pred)},
            "archetype": {"mae_log10": mae_log(archetype_pred), "mae_W_m2": mae_lin(archetype_pred)},
        },
        "train_perihelia": sorted(list(TRAIN_PERIHELIA)),
        "test_perihelia": sorted(list(TEST_PERIHELIA)),
    }

    p_persist = results["policies"]["persistence"]["mae_log10"]
    p_arch = results["policies"]["archetype"]["mae_log10"]
    delta_pct = (p_persist - p_arch) / max(p_persist, 1e-12) * 100.0
    results["archetype_vs_persistence_pct"] = float(delta_pct)
    results["gate_2_pass"] = bool(delta_pct > 3.0)

    print("\n[stage-6] policy   |   MAE log10   |   MAE W/m²")
    print("[stage-6] ---------+---------------+--------------")
    for name, p in results["policies"].items():
        print(f"[stage-6] {name:<8} | {p['mae_log10']:13.4f} | {p['mae_W_m2']:13.1f}")
    print(f"\n[stage-6] archetype vs persistence: {delta_pct:+.2f}% improvement in MAE log10")
    verdict = "PASS" if results["gate_2_pass"] else "FAIL"
    print(f"[stage-6] Gate-2 (>3% improvement): {verdict}")

    out_root = Path("stellar_cache")
    spec_dir = out_root / "specialists"
    eval_dir = out_root / "evaluation"
    spec_dir.mkdir(parents=True, exist_ok=True)
    eval_dir.mkdir(parents=True, exist_ok=True)

    spec_payload = {
        "feature_cols": FEATURE_COLS,
        "scaler_mean": scaler.mean_.tolist(),
        "scaler_scale": scaler.scale_.tolist(),
        "horizon_hours": FORECAST_HORIZON_HOURS,
        "ridge_alpha": RIDGE_ALPHA,
        "y_target": "log10_E_harvest_W_m2",
        "specialists": specialists,
        "global_y_train_mean_log10": float(np.mean(y_train)),
        "train_perihelia": sorted(list(TRAIN_PERIHELIA)),
        "test_perihelia": sorted(list(TEST_PERIHELIA)),
        "n_train_pairs": int(len(train)),
    }
    with open(spec_dir / "specialists.json", "w") as f:
        json.dump(spec_payload, f, indent=2)
    with open(eval_dir / "results.json", "w") as f:
        json.dump(results, f, indent=2)
    print(f"\n[stage-5] wrote specialists.json")
    print(f"[stage-6] wrote results.json")

    api = HfApi(token=token)
    api.upload_file(
        path_or_fileobj=str(spec_dir / "specialists.json"),
        path_in_repo="specialists/specialists.json",
        repo_id=REPO_ID, repo_type="dataset",
        commit_message=f"stage-5: {len(specialists)} per-archetype Ridge specialists",
    )
    api.upload_file(
        path_or_fileobj=str(eval_dir / "results.json"),
        path_in_repo="evaluation/results.json",
        repo_id=REPO_ID, repo_type="dataset",
        commit_message=f"stage-6: Gate-2 {verdict} ({delta_pct:+.2f}%)",
    )
    print("[stage-6] pushed both artifacts to HF dataset")
    return 0


if __name__ == "__main__":
    sys.exit(main())
