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
FORECAST_HORIZONS = [12, 24, 48, 72]  # hours — sweep, not a single point
PAIR_TOLERANCE_SECONDS = 1800
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


def evaluate_horizon(df: pd.DataFrame, horizon_hours: int) -> dict:
    pairs = build_pairs(df, horizon_hours)
    print(f"\n[stage-5] === horizon Δ = {horizon_hours}h ===")
    print(f"[stage-5] pairs: {len(pairs)}  per-perihelion: {pairs['perihelion'].value_counts().sort_index().to_dict()}")
    train = pairs[pairs["perihelion"].isin(TRAIN_PERIHELIA)].reset_index(drop=True)
    test = pairs[pairs["perihelion"].isin(TEST_PERIHELIA)].reset_index(drop=True)
    if len(test) == 0 or len(train) < 50:
        print(f"[stage-5] insufficient data at Δ={horizon_hours}h (train={len(train)}, test={len(test)}); skipping")
        return {"horizon_hours": horizon_hours, "skipped": True, "train": len(train), "test": len(test)}

    scaler = StandardScaler()
    X_train = scaler.fit_transform(train[FEATURE_COLS].to_numpy())
    X_test = scaler.transform(test[FEATURE_COLS].to_numpy())
    y_train = np.log10(train["E_future"].to_numpy() / train["E_now"].to_numpy())
    y_test = np.log10(test["E_future"].to_numpy() / test["E_now"].to_numpy())
    print(f"[stage-5] target drift dex — y_train mean={y_train.mean():+.4f} std={y_train.std():.4f} | y_test mean={y_test.mean():+.4f} std={y_test.std():.4f}")

    specialists: dict[int, dict] = {}
    for c in sorted(train["cluster"].unique()):
        mask = train["cluster"].to_numpy() == c
        n = int(mask.sum())
        if n < MIN_TRAIN_PER_CLUSTER:
            continue
        ridge = Ridge(alpha=RIDGE_ALPHA)
        ridge.fit(X_train[mask], y_train[mask])
        specialists[int(c)] = {
            "type": "ridge",
            "coef": ridge.coef_.tolist(),
            "intercept": float(ridge.intercept_),
            "n_train": n,
        }

    fixed_pred = np.full(len(test), float(np.mean(y_train)))
    persist_pred = np.zeros(len(test))
    archetype_pred = np.empty(len(test))
    for i in range(len(test)):
        c = int(test["cluster"].iloc[i])
        spec = specialists.get(c)
        if spec is None:
            archetype_pred[i] = float(np.mean(y_train))
        else:
            archetype_pred[i] = float(np.array(spec["coef"]) @ X_test[i] + spec["intercept"])

    E_now_t = test["E_now"].to_numpy()
    E_fut_t = test["E_future"].to_numpy()

    def mae_drift(p): return float(np.mean(np.abs(p - y_test)))
    def mae_E(p):
        E_pred = E_now_t * (10.0 ** p)
        return float(np.mean(np.abs(E_pred - E_fut_t)))

    p_persist = mae_drift(persist_pred)
    p_fixed = mae_drift(fixed_pred)
    p_arch = mae_drift(archetype_pred)
    delta_vs_persist = (p_persist - p_arch) / max(p_persist, 1e-12) * 100.0
    delta_vs_fixed = (p_fixed - p_arch) / max(p_fixed, 1e-12) * 100.0
    return {
        "horizon_hours": horizon_hours,
        "n_train_pairs": int(len(train)),
        "n_test_pairs": int(len(test)),
        "specialists_trained": [int(c) for c in specialists.keys()],
        "policies": {
            "fixed":     {"mae_drift_dex": p_fixed,   "mae_E_W_m2": mae_E(fixed_pred)},
            "persistence": {"mae_drift_dex": p_persist, "mae_E_W_m2": mae_E(persist_pred)},
            "archetype": {"mae_drift_dex": p_arch,    "mae_E_W_m2": mae_E(archetype_pred)},
        },
        "archetype_vs_persistence_pct": float(delta_vs_persist),
        "archetype_vs_fixed_pct": float(delta_vs_fixed),
        "gate_2_strict_pass": bool(delta_vs_persist > 3.0 and delta_vs_fixed > 3.0),
        "gate_2_legacy_pass": bool(delta_vs_persist > 3.0),
        "y_train_drift_std": float(y_train.std()),
        "y_test_drift_std": float(y_test.std()),
        "scaler_mean": scaler.mean_.tolist(),
        "scaler_scale": scaler.scale_.tolist(),
        "specialists": specialists,
    }


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

    horizon_results = []
    for h in FORECAST_HORIZONS:
        try:
            horizon_results.append(evaluate_horizon(df, h))
        except Exception as e:
            print(f"[stage-5] horizon Δ={h}h failed: {e}", file=sys.stderr)
            horizon_results.append({"horizon_hours": h, "error": str(e)})

    print("\n[stage-6] === horizon-sweep summary ===")
    print(f"[stage-6] {'Δh':>5} | {'n_pairs':>10} | {'fixed':>9} | {'persist':>9} | {'archetype':>9} | {'vs_pers%':>9} | {'vs_fix%':>9} | strict")
    print(f"[stage-6] {'-'*5} | {'-'*10} | {'-'*9} | {'-'*9} | {'-'*9} | {'-'*9} | {'-'*9} | ------")
    any_strict_pass = False
    for r in horizon_results:
        if r.get("skipped") or r.get("error"):
            print(f"[stage-6] {r['horizon_hours']:>5} | (skipped/error)")
            continue
        pol = r["policies"]
        strict_str = "PASS" if r["gate_2_strict_pass"] else "FAIL"
        if r["gate_2_strict_pass"]:
            any_strict_pass = True
        print(
            f"[stage-6] {r['horizon_hours']:>5} | {r['n_test_pairs']+r['n_train_pairs']:>10} | "
            f"{pol['fixed']['mae_drift_dex']:>9.4f} | {pol['persistence']['mae_drift_dex']:>9.4f} | "
            f"{pol['archetype']['mae_drift_dex']:>9.4f} | {r['archetype_vs_persistence_pct']:>+8.2f}% | "
            f"{r['archetype_vs_fixed_pct']:>+8.2f}% | {strict_str}"
        )

    results = {
        "metric_primary": "MAE in drift = log10(E_future / E_now)",
        "horizons_evaluated": FORECAST_HORIZONS,
        "any_horizon_strict_pass": bool(any_strict_pass),
        "by_horizon": horizon_results,
        "train_perihelia": sorted(list(TRAIN_PERIHELIA)),
        "test_perihelia": sorted(list(TEST_PERIHELIA)),
    }
    verdict = "PASS-ANY" if any_strict_pass else "FAIL-ALL"

    out_root = Path("stellar_cache")
    spec_dir = out_root / "specialists"
    eval_dir = out_root / "evaluation"
    spec_dir.mkdir(parents=True, exist_ok=True)
    eval_dir.mkdir(parents=True, exist_ok=True)

    # Persist the best (or last-passing, or last) horizon's specialists for stage 7.
    chosen = None
    for r in horizon_results:
        if r.get("skipped") or r.get("error"):
            continue
        if r.get("gate_2_strict_pass") and (chosen is None or r["horizon_hours"] < chosen["horizon_hours"]):
            chosen = r
    if chosen is None:
        chosen = next((r for r in horizon_results if not r.get("skipped") and not r.get("error")), None)

    spec_payload = {
        "feature_cols": FEATURE_COLS,
        "ridge_alpha": RIDGE_ALPHA,
        "y_target": "drift_log10_E_ratio",
        "horizons_evaluated": FORECAST_HORIZONS,
        "chosen_horizon_hours": chosen["horizon_hours"] if chosen else None,
        "scaler_mean": chosen["scaler_mean"] if chosen else None,
        "scaler_scale": chosen["scaler_scale"] if chosen else None,
        "specialists": chosen["specialists"] if chosen else {},
        "train_perihelia": sorted(list(TRAIN_PERIHELIA)),
        "test_perihelia": sorted(list(TEST_PERIHELIA)),
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
        commit_message=f"stage-5: specialists ({chosen['horizon_hours'] if chosen else 'none'}h chosen)",
    )
    api.upload_file(
        path_or_fileobj=str(eval_dir / "results.json"),
        path_in_repo="evaluation/results.json",
        repo_id=REPO_ID, repo_type="dataset",
        commit_message=f"stage-6: Gate-2 horizon-sweep {verdict}",
    )
    print("[stage-6] pushed both artifacts to HF dataset")
    return 0


if __name__ == "__main__":
    sys.exit(main())
