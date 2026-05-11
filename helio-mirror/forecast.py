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

from gates import Gate
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
                  horizon_h: int, step_h: int,
                  ml_specialist: dict | None = None) -> pd.DataFrame:
    t0 = pd.Timestamp(latest_row["timestamp"]).tz_localize(None)
    t_forecast = pd.date_range(t0 + pd.Timedelta(hours=step_h),
                                t0 + pd.Timedelta(hours=horizon_h),
                                freq=f"{step_h}h")
    r0 = float(latest_row["body_r_au"])
    i0 = float(latest_row["inferred_irradiance_proxy"])
    lon0 = float(latest_row["body_helio_lon_deg"])
    phase0 = float(latest_row["phase_angle_deg"])
    model_label = "persistence_r2"
    if ml_specialist is not None:
        model_label = "persistence_r2_plus_ml_residual"
        scaler_mean = np.array(ml_specialist["scaler_mean"])
        scaler_scale = np.array(ml_specialist["scaler_scale"])
        coef = np.array(ml_specialist["coef"])
        intercept = float(ml_specialist["intercept"])

    rows = []
    body_eph = body_eph.sort_values("timestamp")
    for t in t_forecast:
        idx = (body_eph["timestamp"] - t).abs().idxmin()
        r_t = float(body_eph.loc[idx, "r_au"])
        lon_t = float(body_eph.loc[idx, "helio_lon_deg"])
        i_persist = i0 * (r0 / r_t) ** 2 if r_t > 0 else float("nan")
        i_pred = i_persist
        residual_added = 0.0
        if ml_specialist is not None and np.isfinite(i_persist) and i_persist > 0:
            interval_h = (t - t0).total_seconds() / 3600.0
            delta_lon = ((lon_t - lon0 + 180) % 360) - 180
            feats = np.array([
                np.log10(i0),
                r_t - r0,
                delta_lon,
                0.0,            # phase angle delta — unknown at forecast time without observer geometry
                interval_h,
            ])
            z = (feats - scaler_mean) / scaler_scale
            residual_added = float(z @ coef + intercept)
            i_pred = i_persist * (10.0 ** residual_added)
        rows.append({
            "forecast_for_timestamp": t,
            "horizon_h": int((t - t0).total_seconds() // 3600),
            "body": latest_row["body"],
            "filter": latest_row.get("filter"),
            "anchor_timestamp": t0,
            "anchor_inferred_irradiance_proxy": i0,
            "anchor_r_au": r0,
            "predicted_r_au": r_t,
            "predicted_helio_lon_deg": lon_t,
            "predicted_inferred_irradiance_proxy_persistence": i_persist,
            "ml_residual_log10": residual_added,
            "predicted_inferred_irradiance_proxy": i_pred,
            "model": model_label,
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

    with Gate("forecast", PERIHELION, REPO_ID, api=api) as g:
        rc = _main_inner(token, api, g)
    return rc


def _main_inner(token: str, api: HfApi, gate: Gate) -> int:
    irr = load(token, f"irradiance/delivered_{PERIHELION}.parquet")
    eph_long = load(token, f"coords/ephemeris_long_{PERIHELION}.parquet")
    coinc = load(token, f"events/coincidences_{PERIHELION}.parquet", required=False)
    if irr.empty or eph_long.empty:
        print("[stage-6] missing irradiance or ephemeris", file=sys.stderr)
        return 1

    ml_specialists: dict = {}
    try:
        files = list_repo_files(REPO_ID, repo_type="dataset", token=token)
        if "forecast/ml_residual.json" in files:
            ml_path = hf_hub_download(repo_id=REPO_ID, repo_type="dataset",
                                       filename="forecast/ml_residual.json",
                                       token=token)
            ml_data = json.loads(Path(ml_path).read_text())
            if ml_data.get("status") == "trained":
                ml_specialists = ml_data.get("specialists", {})
                print(f"[stage-6] ML residual specialists available for: "
                      f"{list(ml_specialists.keys())}")
            else:
                print(f"[stage-6] ML residual gated ({ml_data.get('status')}); "
                      "using persistence baseline only")
    except Exception as e:
        print(f"[stage-6] ml_residual load failed: {e}", file=sys.stderr)

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
        spec = ml_specialists.get(lr["body"])
        fc = forecast_one(lr, body_eph, HORIZON_HOURS, STEP_HOURS, ml_specialist=spec)
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

    psp_eph = eph_long[eph_long["body"] == "PSP"].sort_values("timestamp")
    psp_candidates = load(token, f"events/psp_candidate_events_{PERIHELION}.parquet",
                           required=False)
    n_total_events = int(len(psp_candidates)) if not psp_candidates.empty else 0
    psp_summary = None
    if not psp_eph.empty:
        psp_summary = {
            "perihelion": PERIHELION,
            "r_au": float(psp_eph["r_au"].min()),
            "lon_deg": float(psp_eph.iloc[len(psp_eph) // 2]["helio_lon_deg"]),
            "n_events": n_total_events,
        }
    from targets import SPACECRAFT
    probe_events = load(token, f"events/probe_candidate_events_{PERIHELION}.parquet",
                          required=False)
    probe_summaries: dict[str, dict] = {}
    for sc in SPACECRAFT:
        if sc == "PSP":
            continue
        sc_eph = eph_long[eph_long["body"] == sc].sort_values("timestamp")
        if sc_eph.empty:
            continue
        n_ev = 0
        if not probe_events.empty and "spacecraft" in probe_events.columns:
            n_ev = int((probe_events["spacecraft"] == sc).sum())
        mid = sc_eph.iloc[len(sc_eph) // 2]
        probe_summaries[sc] = {
            "r_au": float(mid["r_au"]),
            "lon_deg": float(mid["helio_lon_deg"]),
            "lat_deg": float(mid["helio_lat_deg"]),
            "n_events": n_ev,
        }
    probe_coincidences = load(token, f"events/probe_coincidences_{PERIHELION}.parquet",
                                required=False)
    n_probe_matched = (int(probe_coincidences["matched"].sum())
                        if not probe_coincidences.empty and "matched" in probe_coincidences.columns
                        else 0)
    n_probe_candidate = int(len(probe_coincidences))

    probe_pairs_by_pair: list[dict] = []
    median_probe_match_score: float | None = None
    probes_load_status: dict | None = None
    try:
        files = list_repo_files(REPO_ID, repo_type="dataset", token=token)
        sum_name = f"events/coincidences_summary_{PERIHELION}.json"
        if sum_name in files:
            sp = hf_hub_download(repo_id=REPO_ID, repo_type="dataset",
                                   filename=sum_name, token=token)
            sdata = json.loads(Path(sp).read_text())
            probe_pairs_by_pair = sdata.get("probe_pairs_by_pair") or []
            median_probe_match_score = sdata.get("median_probe_match_score")
        stat_name = f"status/probes_status_{PERIHELION}.json"
        if stat_name in files:
            stp = hf_hub_download(repo_id=REPO_ID, repo_type="dataset",
                                    filename=stat_name, token=token)
            probes_load_status = json.loads(Path(stp).read_text())
    except Exception as e:
        print(f"[stage-6] coincidences_summary/probes_status load skipped: {e}",
              file=sys.stderr)

    latest = {
        "perihelion": PERIHELION,
        "model": ("persistence_r2_plus_ml_residual" if ml_specialists else "persistence_r2"),
        "horizon_hours": HORIZON_HOURS,
        "step_hours": STEP_HOURS,
        "generated_at": pd.Timestamp.utcnow().isoformat(),
        "psp": psp_summary,
        "probes": probe_summaries,
        "n_total_psp_events": n_total_events,
        "n_probe_coincidences_candidate": n_probe_candidate,
        "n_probe_coincidences_matched": n_probe_matched,
        "probe_pairs_by_pair": probe_pairs_by_pair,
        "median_probe_match_score": median_probe_match_score,
        "probes_load_status": probes_load_status,
        "bodies": {},
        "caveats": [
            "Forecast is per-body persistence × geometric r² correction; ML residual applied when a per-body specialist is trained.",
            "PSP-event flags are advisory: wind-mechanism arrivals overlapping the forecast horizon get psp_event_flag=True; impact on irradiance not quantified yet.",
            "Inferred-irradiance units are a relative proxy within (body, filter); absolute W/m² requires per-filter calibration not yet applied.",
            "Coincidences (PSP event × JWST obs) require contemporaneous data; current cache has zero matches structurally — multi-probe HSO coincidences (PSP × SolO × STEREO-A × L1) are the real validation route.",
        ],
    }
    irr_sorted = irr.sort_values(["body", "filter", "timestamp"])
    body_anchor_meta: dict[str, dict] = {}
    for (body, filt), g in irr_sorted.groupby(["body", "filter"]):
        last = g.iloc[-1]
        body_anchor_meta.setdefault(body, {
            "phase_angle_deg": float(last["phase_angle_deg"]),
            "delta_au": float(last["delta_au"]),
            "anchor_lon_deg": float(last["body_helio_lon_deg"]),
        })
    for body in forecast["body"].unique():
        sub = forecast[forecast["body"] == body]
        anchor = sub.iloc[0]
        meta = body_anchor_meta.get(body, {})
        latest["bodies"][body] = {
            "filter": str(anchor["filter"]),
            "anchor_timestamp": anchor["anchor_timestamp"].isoformat(),
            "anchor_r_au": float(anchor["anchor_r_au"]),
            "anchor_lon_deg": meta.get("anchor_lon_deg"),
            "anchor_inferred_irradiance_proxy":
                float(anchor["anchor_inferred_irradiance_proxy"]),
            "phase_angle_deg": meta.get("phase_angle_deg"),
            "delta_au": meta.get("delta_au"),
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
    per_perihelion_path = out_dir / f"latest_{PERIHELION}.json"
    payload = json.dumps(latest, indent=2, default=str)
    latest_path.write_text(payload)
    per_perihelion_path.write_text(payload)
    from hf_push import push_folder
    push_folder(api, REPO_ID, out_dir, "forecast",
                 f"stage-6: 24h forecast + latest summary {PERIHELION}",
                 allow_patterns=[f"forecast_24h_{PERIHELION}.parquet",
                                  "latest.json",
                                  f"latest_{PERIHELION}.json"])
    print(f"[stage-6] pushed forecast/ for {PERIHELION} as one commit")
    print("[stage-6] done.")

    gate.n_inputs = int(len(irr))
    gate.n_outputs = int(len(forecast))
    gate.notes = {
        "n_bodies_forecast": int(forecast["body"].nunique()),
        "model": latest["model"],
        "n_probes_with_data": len(probe_summaries),
        "n_probe_coincidences_matched": n_probe_matched,
        "ml_residual_trained": bool(ml_specialists),
    }
    if gate.n_outputs == 0:
        gate.ok = False
        gate.reason = "0 forecast rows produced"
    return 0


if __name__ == "__main__":
    sys.exit(main())
