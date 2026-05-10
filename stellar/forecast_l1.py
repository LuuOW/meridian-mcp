#!/usr/bin/env python3
"""
Stage 8 — HelioCast L1 forecast layer.

Combines the PSP-derived archetype regime classifier with Earth-PSP Parker
spiral geometry to produce an Earth-relevant forecast: when the wind sampled
at PSP is geometrically advecting to Earth, project the archetype label and
specialist drift forecast forward by the advection lead time.

Constraints (shipped honestly):
  - Archetype-at-L1 uses a persistence-of-archetype assumption over the
    advection window. Held-out testability: within E20-E24, how often does
    the cluster label change over a typical 80-hour advection window?
  - Drift forecast comes from the existing Ridge specialists (toy harvest
    target). Reported as a regime-stability indicator, not as W/m².
  - Forecast is silent outside Parker connection windows. No fabrication.

Outputs:
  parker/forecast_l1.parquet    — per-(connected window) forecast row
  parker/forecast_l1_latest.json — most recent connected forecast for the dashboard
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from huggingface_hub import HfApi, hf_hub_download

REPO_ID = "luuow/meridian-stellar-cache"


def grab(filename: str, token: str) -> str:
    return hf_hub_download(repo_id=REPO_ID, repo_type="dataset",
                           filename=filename, token=token)


def predict_drift_per_row(features: np.ndarray, clusters: np.ndarray,
                           specialists: dict) -> np.ndarray:
    scaler_mean = np.array(specialists["scaler_mean"])
    scaler_scale = np.array(specialists["scaler_scale"])
    z = (features - scaler_mean) / scaler_scale
    out = np.full(len(features), np.nan)
    for cid, spec in specialists["specialists"].items():
        mask = clusters == int(cid)
        if not mask.any():
            continue
        coef = np.array(spec["coef"])
        intercept = float(spec["intercept"])
        out[mask] = z[mask] @ coef + intercept
    return out


def assess_archetype_persistence(labels_df: pd.DataFrame,
                                  advection_hours: float = 80.0) -> dict:
    h_seconds = int(advection_hours * 3600)
    labels_df = labels_df.copy()
    labels_df["t_s"] = labels_df["win_start"].astype("int64") / 1e9
    same_label = []
    transitions = {}
    for peri, g in labels_df.groupby("perihelion"):
        g = g.sort_values("t_s").reset_index(drop=True)
        t = g["t_s"].to_numpy()
        c = g["cluster"].to_numpy()
        for i in range(len(g)):
            j = np.searchsorted(t, t[i] + h_seconds)
            if j >= len(g):
                continue
            if abs(t[j] - (t[i] + h_seconds)) > 1800:
                continue
            same_label.append(c[i] == c[j])
            key = f"{int(c[i])}->{int(c[j])}"
            transitions[key] = transitions.get(key, 0) + 1
    return {
        "advection_hours": advection_hours,
        "n_pairs": len(same_label),
        "p_same_label": float(np.mean(same_label)) if same_label else None,
        "top_transitions": dict(sorted(transitions.items(),
                                        key=lambda kv: -kv[1])[:6]),
    }


def main() -> int:
    if "HF_TOKEN" not in os.environ:
        print("ERROR: HF_TOKEN not set", file=sys.stderr)
        return 1
    token = os.environ["HF_TOKEN"]

    parker_path = grab("parker/connection.parquet", token)
    labels_path = grab("archetypes/labels.parquet", token)
    harvest_path = grab("harvest/E_truth.parquet", token)
    specialists_path = grab("specialists/specialists.json", token)

    parker = pd.read_parquet(parker_path)
    labels = pd.read_parquet(labels_path)
    harvest = pd.read_parquet(harvest_path)[["win_start", "perihelion"]]
    specialists = json.loads(Path(specialists_path).read_text())

    parker["win_start"] = pd.to_datetime(parker["win_start"]).dt.tz_localize(None)
    labels["win_start"] = pd.to_datetime(labels["win_start"]).dt.tz_localize(None)
    harvest["win_start"] = pd.to_datetime(harvest["win_start"]).dt.tz_localize(None)
    labels = labels.merge(harvest, on="win_start", how="left")

    df = parker.merge(
        labels[["win_start", "cluster"] + specialists["feature_cols"]],
        on="win_start", how="left",
    )
    print(f"[stage-8] joined parker × labels: {len(df)} rows, "
          f"{int(df['parker_connected'].sum())} connected")

    feature_arr = df[specialists["feature_cols"]].to_numpy()
    cluster_arr = df["cluster"].fillna(-1).astype(int).to_numpy()
    df["predicted_drift_dex"] = predict_drift_per_row(
        feature_arr, cluster_arr, specialists)

    chosen_h = specialists.get("chosen_horizon_hours", 48)
    df["chosen_horizon_hours"] = chosen_h
    df["specialist_applied"] = ~np.isnan(df["predicted_drift_dex"])

    df["L1_arrival_eta"] = (
        df["win_start"] + pd.to_timedelta(df["advection_lead_hours"], unit="h")
    )
    df["expected_archetype_at_L1_persistence"] = df["cluster"]

    persistence_eval = assess_archetype_persistence(labels, advection_hours=80.0)
    print(f"[stage-8] archetype-persistence over 80h "
          f"(geometric advection median): "
          f"{persistence_eval['p_same_label']:.2%} "
          f"({persistence_eval['n_pairs']} pairs)")
    print(f"[stage-8] top transitions: {persistence_eval['top_transitions']}")

    connected = df[df["parker_connected"]].copy().sort_values("win_start")
    print(f"\n[stage-8] connected forecasts: {len(connected)} rows")
    if not connected.empty:
        print(connected.groupby("perihelion")[
            ["advection_lead_hours", "cluster", "predicted_drift_dex"]
        ].agg({
            "advection_lead_hours": "median",
            "cluster": lambda s: s.value_counts().to_dict(),
            "predicted_drift_dex": "median",
        }).to_string())

    out_dir = Path("stellar_cache/parker")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "forecast_l1.parquet"
    out_cols = [
        "win_start", "win_end", "perihelion", "parker_connected",
        "advection_lead_hours", "L1_arrival_eta",
        "psp_lon_deg", "earth_lon_deg", "psp_r_au", "connection_residual_deg",
        "cluster", "expected_archetype_at_L1_persistence",
        "predicted_drift_dex", "specialist_applied", "chosen_horizon_hours",
    ]
    df[out_cols].to_parquet(out_path, compression="snappy")
    print(f"[stage-8] wrote {out_path}")

    if connected.empty:
        latest = {"status": "no_connection_in_cache"}
    else:
        last = connected.iloc[-1]
        latest = {
            "win_start": last["win_start"].isoformat(),
            "win_end": pd.Timestamp(last["win_end"]).isoformat(),
            "perihelion": last["perihelion"],
            "advection_lead_hours": float(last["advection_lead_hours"]),
            "L1_arrival_eta": last["L1_arrival_eta"].isoformat(),
            "psp_r_au": float(last["psp_r_au"]),
            "connection_residual_deg": float(last["connection_residual_deg"]),
            "current_archetype": (None if pd.isna(last["cluster"])
                                  else int(last["cluster"])),
            "expected_archetype_at_L1": (None if pd.isna(last["cluster"])
                                          else int(last["cluster"])),
            "predicted_drift_dex": (None if pd.isna(last["predicted_drift_dex"])
                                    else float(last["predicted_drift_dex"])),
            "chosen_horizon_hours": chosen_h,
        }
    summary = {
        "v_sw_km_s": 400.0,
        "tolerance_deg": 10.0,
        "archetype_persistence_eval": persistence_eval,
        "n_total_windows": int(len(df)),
        "n_connected_windows": int(len(connected)),
        "fraction_connected": (float(len(connected)) / len(df)
                                if len(df) else 0.0),
        "latest_connected": latest,
        "caveats": [
            "Forecast is silent outside Parker-spiral connection windows.",
            "Archetype-at-L1 assumes persistence over advection lead time.",
            "Drift forecast is from the toy E_harvest target — regime stability proxy, not W/m².",
            "v_sw=400 km/s assumed; real solar wind speed varies by ±150 km/s.",
        ],
    }
    summary_path = out_dir / "forecast_l1_latest.json"
    summary_path.write_text(json.dumps(summary, indent=2, default=str))
    print(f"[stage-8] wrote {summary_path}")

    api = HfApi(token=token)
    api.upload_file(
        path_or_fileobj=str(out_path),
        path_in_repo="parker/forecast_l1.parquet",
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message="stage-8: HelioCast L1 forecast (per-connected-window)",
    )
    api.upload_file(
        path_or_fileobj=str(summary_path),
        path_in_repo="parker/forecast_l1_latest.json",
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message="stage-8: HelioCast latest forecast summary",
    )
    print(f"[stage-8] pushed parker/forecast_l1 artifacts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
