#!/usr/bin/env python3
"""
Stage 6 — irradiance forecaster (deterministic baseline + PSP context).

For each body with at least one JWST observation in the perihelion window,
forecast the inferred-irradiance proxy hourly for the next 24 h.

Baseline: persistence with geometric r² correction
  I(t + Δt) = I(t_last) × (r(t_last) / r(t + Δt))²

This is the deterministic floor — it accounts only for the body's own orbital
motion (Sun-body distance changing) and assumes the Sun emits the same in
that direction. Beats no-correction persistence whenever r changes noticeably.

PSP context (lightweight, no ML training yet at this data scale):
  If a coincidence record indicates a wind event predicted to arrive at the
  body within the 24 h forecast horizon, flag the affected hours with a
  confidence-band downgrade and record the implicated PSP event timestamp.

Outputs to `luuow/meridian-helio-mirror`:
  forecast/forecast_24h_{PERIHELION}.parquet  — hourly per-body forecast
  forecast/latest.json                         — small JSON for dashboard consumption
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from huggingface_hub import HfApi, hf_hub_download, list_repo_files

from targets import PERIHELIA

REPO_ID = "luuow/meridian-helio-mirror"
PERIHELION = os.environ.get("HELIO_PERIHELION", "E20")
HORIZON_HOURS = int(os.environ.get("HELIO_HORIZON_H", "24"))
STEP_HOURS = int(os.environ.get("HELIO_STEP_H", "1"))


def push(api: HfApi, local: Path, repo_path: str, message: str) -> None:
    from hf_push import push as _push
    _push(api, REPO_ID, local, repo_path, message)


def load(token: str, name: str, required: bool = True) -> pd.DataFrame:
    files = list_repo_files(REPO_ID, repo_type="dataset", token=token)
    if name not in files:
        if required:
            print(f"[stage-6] missing {name}", file=sys.stderr)
        return pd.DataFrame()
    p = hf_hub_download(repo_id=REPO_ID, repo_type="dataset",
                        filename=name, token=token)
    return pd.read_parquet(p)


def latest_per_body(irr: pd.DataFrame) -> pd.DataFrame:
    irr = irr.sort_values(["body", "filter", "timestamp"])
    return irr.groupby(["body", "filter"], as_index=False).tail(1)


def forecast_one(latest_row: pd.Series, body_eph: pd.DataFrame,
                  horizon_h: int, step_h: int) -> pd.DataFrame:
    t0 = pd.Timestamp(latest_row["timestamp"]).tz_localize(None)
    t_forecast = pd.date_range(t0 + pd.Timedelta(hours=step_h),
                                t0 + pd.Timedelta(hours=horizon_h),
                                freq=f"{step_h}h")
    r0 = float(latest_row["body_r_au"])
    i0 = float(latest_row["inferred_irradiance_proxy"])

    rows = []
    body_eph = body_eph.sort_values("timestamp")
    for t in t_forecast:
        idx = (body_eph["timestamp"] - t).abs().idxmin()
        r_t = float(body_eph.loc[idx, "r_au"])
        i_pred = i0 * (r0 / r_t) ** 2 if r_t > 0 else float("nan")
        rows.append({
            "forecast_for_timestamp": t,
            "horizon_h": int((t - t0).total_seconds() // 3600),
            "body": latest_row["body"],
            "filter": latest_row.get("filter"),
            "anchor_timestamp": t0,
            "anchor_inferred_irradiance_proxy": i0,
            "anchor_r_au": r0,
            "predicted_r_au": r_t,
            "predicted_helio_lon_deg": float(body_eph.loc[idx, "helio_lon_deg"]),
            "predicted_inferred_irradiance_proxy": i_pred,
            "model": "persistence_r2",
        })
    return pd.DataFrame(rows)


def annotate_psp_events(forecast: pd.DataFrame, coincidences: pd.DataFrame) -> pd.DataFrame:
    if coincidences.empty:
        forecast["psp_event_flag"] = False
        forecast["psp_event_match_score"] = 0.0
        return forecast
    flags = np.zeros(len(forecast), dtype=bool)
    scores = np.zeros(len(forecast))
    for i, row in forecast.reset_index(drop=True).iterrows():
        body = row["body"]
        t = row["forecast_for_timestamp"]
        match = coincidences[(coincidences["body"] == body)
                              & (coincidences["mechanism"] == "wind")]
        if match.empty:
            continue
        match = match.copy()
        match["dt_h"] = (
            (match["predicted_arrival_timestamp"] - t).dt.total_seconds() / 3600.0
        ).abs()
        within = match[match["dt_h"] < 6.0]
        if within.empty:
            continue
        flags[i] = True
        scores[i] = float(within["match_score"].max())
    out = forecast.copy()
    out["psp_event_flag"] = flags
    out["psp_event_match_score"] = scores
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

    irr = load(token, f"irradiance/delivered_{PERIHELION}.parquet")
    eph_long = load(token, f"coords/ephemeris_long_{PERIHELION}.parquet")
    coinc = load(token, f"events/coincidences_{PERIHELION}.parquet", required=False)
    if irr.empty or eph_long.empty:
        print("[stage-6] missing irradiance or ephemeris", file=sys.stderr)
        return 1

    eph_long = eph_long.copy()
    eph_long["timestamp"] = pd.to_datetime(eph_long["timestamp"]).dt.tz_localize(None)
    irr = irr.copy()
    irr["timestamp"] = pd.to_datetime(irr["timestamp"]).dt.tz_localize(None)
    if not coinc.empty:
        coinc = coinc.copy()
        coinc["predicted_arrival_timestamp"] = pd.to_datetime(
            coinc["predicted_arrival_timestamp"]).dt.tz_localize(None)

    latest_obs = latest_per_body(irr)
    print(f"[stage-6] forecasting from {len(latest_obs)} latest obs "
          f"({latest_obs['body'].nunique()} bodies)")

    forecasts: list[pd.DataFrame] = []
    for _, lr in latest_obs.iterrows():
        body_eph = eph_long[eph_long["body"] == lr["body"]]
        if body_eph.empty:
            continue
        fc = forecast_one(lr, body_eph, HORIZON_HOURS, STEP_HOURS)
        forecasts.append(fc)
    if not forecasts:
        print("[stage-6] no forecasts produced", file=sys.stderr)
        return 1
    forecast = pd.concat(forecasts, ignore_index=True)
    forecast = annotate_psp_events(forecast, coinc)
    print(f"[stage-6] {len(forecast)} hourly forecast rows")
    print(forecast.groupby("body")[["horizon_h", "predicted_inferred_irradiance_proxy",
                                     "psp_event_flag"]].agg({
        "horizon_h": ["min", "max"],
        "predicted_inferred_irradiance_proxy": "median",
        "psp_event_flag": "sum",
    }).to_string())

    out_dir = Path("helio_cache/forecast")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"forecast_24h_{PERIHELION}.parquet"
    forecast.to_parquet(out_path, compression="snappy")
    push(api, out_path, f"forecast/forecast_24h_{PERIHELION}.parquet",
         f"stage-6: 24 h irradiance forecast per body {PERIHELION}")

    latest = {
        "perihelion": PERIHELION,
        "model": "persistence_r2",
        "horizon_hours": HORIZON_HOURS,
        "step_hours": STEP_HOURS,
        "generated_at": pd.Timestamp.utcnow().isoformat(),
        "bodies": {},
        "caveats": [
            "Forecast is per-body persistence × geometric r² correction.",
            "ML residual layer not yet trained — needs more JWST observations per body.",
            "PSP-event flags are advisory: wind-mechanism arrivals overlapping the "
            "forecast horizon get psp_event_flag=True; impact on irradiance not "
            "quantified yet.",
            "Inferred-irradiance units are a relative proxy within (body, filter); "
            "absolute W/m² requires per-filter calibration not yet applied.",
        ],
    }
    for body in forecast["body"].unique():
        sub = forecast[forecast["body"] == body]
        anchor = sub.iloc[0]
        latest["bodies"][body] = {
            "filter": str(anchor["filter"]),
            "anchor_timestamp": anchor["anchor_timestamp"].isoformat(),
            "anchor_r_au": float(anchor["anchor_r_au"]),
            "anchor_inferred_irradiance_proxy":
                float(anchor["anchor_inferred_irradiance_proxy"]),
            "forecast": [
                {
                    "h": int(r["horizon_h"]),
                    "ts": r["forecast_for_timestamp"].isoformat(),
                    "r_au": float(r["predicted_r_au"]),
                    "lon_deg": float(r["predicted_helio_lon_deg"]),
                    "i_proxy": float(r["predicted_inferred_irradiance_proxy"]),
                    "psp_flag": bool(r["psp_event_flag"]),
                    "psp_score": float(r["psp_event_match_score"]),
                } for _, r in sub.iterrows()
            ],
        }

    latest_path = out_dir / "latest.json"
    latest_path.write_text(json.dumps(latest, indent=2, default=str))
    push(api, latest_path, "forecast/latest.json",
         f"stage-6: latest forecast summary {PERIHELION}")
    print(f"[stage-6] wrote {out_path} and forecast/latest.json")
    print("[stage-6] done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
