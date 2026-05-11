#!/usr/bin/env python3
"""
Stage 6b — per-body ML residual layer on top of the persistence×r² forecast.

Training target: log10(I_obs) − log10(I_persistence_r2_pred)
  i.e., the residual the deterministic baseline doesn't capture. Positive
  residual = body brighter than geometry predicts; negative = dimmer.

Features (per pair):
  - log10(anchor I_proxy)
  - delta_r_au over the interval (signed)
  - delta_helio_lon_deg over the interval (signed, wrapped)
  - delta_phase_angle_deg if computable
  - interval_hours

Data: all `irradiance/delivered_*.parquet` across the five perihelia
combined. For each body, build (anchor_t, next_obs_t') pairs where t' is
within [12, 36] hours of t (24 h ±50%). Train per-body Ridge if
n_pairs ≥ MIN_TRAIN_PER_BODY (default 10); otherwise emit a gate status
explaining why we're not training.

Output: forecast/ml_residual.json — specialists or insufficient-data gate
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from huggingface_hub import HfApi, hf_hub_download, list_repo_files
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler

from gates import Gate

REPO_ID = "luuow/meridian-helio-mirror"
MIN_TRAIN_PER_BODY = int(os.environ.get("ML_MIN_TRAIN_PER_BODY", "10"))
INTERVAL_HOURS_LO = float(os.environ.get("ML_INTERVAL_LO_H", "12"))
INTERVAL_HOURS_HI = float(os.environ.get("ML_INTERVAL_HI_H", "36"))
RIDGE_ALPHA = 1.0

FEATURE_COLS = [
    "log10_anchor_irr",
    "delta_r_au",
    "delta_helio_lon_deg",
    "delta_phase_angle_deg",
    "interval_h",
]


def push(api: HfApi, local: Path, repo_path: str, message: str) -> None:
    from hf_push import push as _push
    _push(api, REPO_ID, local, repo_path, message)


def load_all_irradiance(token: str) -> pd.DataFrame:
    files = list_repo_files(REPO_ID, repo_type="dataset", token=token)
    irr_files = [f for f in files if f.startswith("irradiance/delivered_") and f.endswith(".parquet")]
    if not irr_files:
        return pd.DataFrame()
    chunks = []
    for f in irr_files:
        p = hf_hub_download(repo_id=REPO_ID, repo_type="dataset", filename=f, token=token)
        df = pd.read_parquet(p)
        df["source_perihelion"] = f.split("delivered_")[1].split(".")[0]
        chunks.append(df)
    out = pd.concat(chunks, ignore_index=True)
    out["timestamp"] = pd.to_datetime(out["timestamp"]).dt.tz_localize(None)
    return out.sort_values(["body", "filter", "timestamp"])


def build_pairs(irr: pd.DataFrame) -> pd.DataFrame:
    rows: list[dict] = []
    for (body, filt), g in irr.groupby(["body", "filter"]):
        g = g.sort_values("timestamp").reset_index(drop=True)
        if len(g) < 2:
            continue
        for i in range(len(g) - 1):
            a = g.iloc[i]
            for j in range(i + 1, len(g)):
                b = g.iloc[j]
                dt_h = (b["timestamp"] - a["timestamp"]).total_seconds() / 3600.0
                if dt_h < INTERVAL_HOURS_LO:
                    continue
                if dt_h > INTERVAL_HOURS_HI:
                    break
                if a["inferred_irradiance_proxy"] <= 0 or b["inferred_irradiance_proxy"] <= 0:
                    continue
                i_anchor = a["inferred_irradiance_proxy"]
                i_truth = b["inferred_irradiance_proxy"]
                r_a, r_b = a["body_r_au"], b["body_r_au"]
                i_persistence = i_anchor * (r_a / r_b) ** 2 if r_b > 0 else np.nan
                if not np.isfinite(i_persistence) or i_persistence <= 0:
                    continue
                residual = np.log10(i_truth) - np.log10(i_persistence)
                rows.append({
                    "body": body, "filter": filt,
                    "anchor_ts": a["timestamp"], "future_ts": b["timestamp"],
                    "log10_anchor_irr": np.log10(i_anchor),
                    "delta_r_au": float(r_b - r_a),
                    "delta_helio_lon_deg": float(
                        ((b["body_helio_lon_deg"] - a["body_helio_lon_deg"] + 180) % 360) - 180),
                    "delta_phase_angle_deg": float(b["phase_angle_deg"] - a["phase_angle_deg"]),
                    "interval_h": dt_h,
                    "log10_truth_irr": np.log10(i_truth),
                    "log10_persistence_pred": np.log10(i_persistence),
                    "residual_log10": residual,
                })
    return pd.DataFrame(rows)


HELD_OUT_FRAC = float(os.environ.get("ML_HELD_OUT_FRAC", "0.2"))
MIN_TEST_PER_BODY = int(os.environ.get("ML_MIN_TEST_PER_BODY", "3"))


def train_per_body(pairs: pd.DataFrame) -> dict:
    """Chronologically held-out split per body: oldest 80% train, newest 20%
    test. Without this we'd report train MAE only, which is overoptimistic —
    same trap that bit the photon-route project (train nDCG 0.747 → holdout
    0.071).

    Skill metric: (baseline_mae_holdout − model_mae_holdout) / baseline_mae_holdout.
    Positive = model beats persistence; negative = persistence wins (gate ML).
    """
    specialists: dict[str, dict] = {}
    insufficient: list[dict] = []
    for body, g in pairs.groupby("body"):
        n = len(g)
        if n < MIN_TRAIN_PER_BODY:
            insufficient.append({"body": body, "n_pairs": int(n),
                                  "reason": f"<{MIN_TRAIN_PER_BODY} pairs"})
            continue
        # Chronological split — never random split time series.
        g_sorted = g.sort_values("anchor_ts").reset_index(drop=True)
        n_test = max(MIN_TEST_PER_BODY, int(round(n * HELD_OUT_FRAC)))
        if n_test >= n:
            insufficient.append({"body": body, "n_pairs": int(n),
                                  "reason": "test set would consume all pairs"})
            continue
        n_train = n - n_test
        if n_train < MIN_TRAIN_PER_BODY:
            insufficient.append({"body": body, "n_pairs": int(n),
                                  "reason": f"after held-out split, train < {MIN_TRAIN_PER_BODY}"})
            continue
        train_df = g_sorted.iloc[:n_train]
        test_df = g_sorted.iloc[n_train:]
        X_tr = train_df[FEATURE_COLS].to_numpy()
        y_tr = train_df["residual_log10"].to_numpy()
        X_te = test_df[FEATURE_COLS].to_numpy()
        y_te = test_df["residual_log10"].to_numpy()
        scaler = StandardScaler().fit(X_tr)
        model = Ridge(alpha=RIDGE_ALPHA).fit(scaler.transform(X_tr), y_tr)
        pred_tr = model.predict(scaler.transform(X_tr))
        pred_te = model.predict(scaler.transform(X_te))
        train_mae = float(np.mean(np.abs(y_tr - pred_tr)))
        test_mae = float(np.mean(np.abs(y_te - pred_te)))
        baseline_train_mae = float(np.mean(np.abs(y_tr)))   # predict residual=0 = persistence
        baseline_test_mae = float(np.mean(np.abs(y_te)))
        skill = ((baseline_test_mae - test_mae) / baseline_test_mae
                  if baseline_test_mae > 1e-9 else 0.0)
        if skill < 0:
            insufficient.append({"body": body, "n_pairs": int(n),
                                  "reason": f"holdout skill {skill:+.3f} (Ridge worse than persistence)",
                                  "train_mae": train_mae, "test_mae": test_mae,
                                  "baseline_test_mae": baseline_test_mae})
            print(f"[stage-6b] {body}: GATED — Ridge skill {skill:+.3f} on holdout "
                  f"(train_mae {train_mae:.4f}, test_mae {test_mae:.4f}, "
                  f"baseline_test_mae {baseline_test_mae:.4f})")
            continue
        specialists[body] = {
            "type": "ridge",
            "feature_cols": FEATURE_COLS,
            "scaler_mean": scaler.mean_.tolist(),
            "scaler_scale": scaler.scale_.tolist(),
            "coef": model.coef_.tolist(),
            "intercept": float(model.intercept_),
            "alpha": RIDGE_ALPHA,
            "n_train": int(n_train),
            "n_test": int(n_test),
            "train_mae_log10": train_mae,
            "test_mae_log10": test_mae,
            "baseline_train_mae_log10": baseline_train_mae,
            "baseline_test_mae_log10": baseline_test_mae,
            "holdout_skill": skill,
        }
        print(f"[stage-6b] {body}: trained on {n_train}, tested on {n_test} — "
              f"skill {skill:+.3f} (test_mae {test_mae:.4f} vs persistence {baseline_test_mae:.4f})")
    return {"specialists": specialists, "insufficient_data": insufficient}


def main() -> int:
    if "HF_TOKEN" not in os.environ:
        print("ERROR: HF_TOKEN not set", file=sys.stderr)
        return 1
    token = os.environ["HF_TOKEN"]
    api = HfApi(token=token)

    with Gate("ml_residual", "ALL", REPO_ID, api=api) as gate:
        rc = _main_inner(token, api, gate)
    return rc


def _main_inner(token: str, api: HfApi, gate: Gate) -> int:
    irr = load_all_irradiance(token)
    if irr.empty:
        print("[stage-6b] no irradiance data — run earlier stages first", file=sys.stderr)
        gate.ok = False
        gate.reason = "no irradiance data"
        return 1
    print(f"[stage-6b] loaded {len(irr)} irradiance rows across "
          f"{irr['body'].nunique()} bodies / {irr['source_perihelion'].nunique()} perihelia")

    pairs = build_pairs(irr)
    print(f"[stage-6b] built {len(pairs)} (anchor, future) pairs in "
          f"[{INTERVAL_HOURS_LO}, {INTERVAL_HOURS_HI}] h window")
    if pairs.empty:
        result = {
            "status": "gated_no_pairs",
            "reason": f"no (anchor, future) observation pairs found within {INTERVAL_HOURS_LO}-{INTERVAL_HOURS_HI} h",
            "n_irradiance_rows": int(len(irr)),
            "n_bodies": int(irr["body"].nunique()),
        }
    else:
        outcome = train_per_body(pairs)
        result = {
            "status": "trained" if outcome["specialists"] else "gated_insufficient_data",
            "min_train_per_body": MIN_TRAIN_PER_BODY,
            "interval_hours": [INTERVAL_HOURS_LO, INTERVAL_HOURS_HI],
            "held_out_frac": HELD_OUT_FRAC,
            "n_pairs_total": int(len(pairs)),
            "n_irradiance_rows": int(len(irr)),
            "feature_cols": FEATURE_COLS,
            "specialists": outcome["specialists"],
            "insufficient_data_bodies": outcome["insufficient_data"],
            "pairs_per_body": pairs.groupby("body").size().to_dict(),
        }
    print(json.dumps({k: v for k, v in result.items() if k != "specialists"}, indent=2, default=str))
    print(f"trained bodies (positive holdout skill): {list(result.get('specialists', {}).keys())}")
    gate.n_inputs = int(len(irr))
    gate.n_outputs = int(len(result.get("specialists") or {}))
    gate.notes = {
        "status": result.get("status"),
        "n_pairs_total": int(len(pairs)),
        "n_bodies_trained": int(len(result.get("specialists") or {})),
        "median_skill": (
            float(np.median([s["holdout_skill"]
                              for s in (result.get("specialists") or {}).values()]))
            if result.get("specialists") else None),
    }
    if not result.get("specialists"):
        gate.reason = f"no body passed holdout skill gate ({result.get('status')})"

    out_dir = Path("helio_cache/forecast")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "ml_residual.json"
    out_path.write_text(json.dumps(result, indent=2, default=str))
    push(api, out_path, "forecast/ml_residual.json",
         "stage-6b: ML residual layer (per-body Ridge or insufficient-data gate)")
    print(f"[stage-6b] pushed forecast/ml_residual.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
