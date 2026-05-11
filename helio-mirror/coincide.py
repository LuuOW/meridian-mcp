#!/usr/bin/env python3
"""
Stage 4 — coincidence finder.

For each PSP candidate event (PVI>threshold), predict when and where the
disturbance would reach each candidate body. Match against JWST observations
of that body.

Two mechanisms:
  - WIND: structures advect radially at v_sw (default 400 km/s, sometime
    pulled from SWEAP/SPAN-I once available). Lead time at 1 AU is ~3.5 d.
  - LIGHT: flare EM signatures travel at c; lead time at 1 AU is ~8 min,
    essentially same JWST observation timestamp.

Outputs to `luuow/meridian-helio-mirror`:
  events/coincidences_{PERIHELION}.parquet — PSP event × JWST observation joined records
  events/coincidences_summary_{PERIHELION}.json — counts, body x mechanism breakdown
"""
from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path

import numpy as np
import pandas as pd
from huggingface_hub import HfApi, hf_hub_download, list_repo_files

from targets import PERIHELIA

REPO_ID = "luuow/meridian-helio-mirror"
PERIHELION = os.environ.get("HELIO_PERIHELION", "E20")

V_SW_KM_PER_SEC = float(os.environ.get("HELIO_V_SW_KM_S", "400.0"))
C_KM_PER_SEC = 299_792.458
AU_KM = 149_597_870.7
OMEGA_SUN_DEG_PER_DAY = 14.713

LON_TOLERANCE_DEG = float(os.environ.get("HELIO_LON_TOL_DEG", "20.0"))
T_TOLERANCE_HOURS_WIND = float(os.environ.get("HELIO_T_TOL_WIND_H", "24.0"))
T_TOLERANCE_HOURS_LIGHT = float(os.environ.get("HELIO_T_TOL_LIGHT_H", "1.0"))


def push(api: HfApi, local: Path, repo_path: str, message: str) -> None:
    api.upload_file(
        path_or_fileobj=str(local),
        path_in_repo=repo_path,
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message=message,
    )


def wrap_180(deg: np.ndarray) -> np.ndarray:
    return ((deg + 180.0) % 360.0) - 180.0


def load(token: str, name: str) -> pd.DataFrame:
    files = list_repo_files(REPO_ID, repo_type="dataset", token=token)
    if name not in files:
        print(f"[stage-4] missing {name}", file=sys.stderr)
        return pd.DataFrame()
    p = hf_hub_download(repo_id=REPO_ID, repo_type="dataset", filename=name, token=token)
    return pd.read_parquet(p)


def predicted_lon_at_arrival(body_eph: pd.DataFrame, t_arrival: pd.Timestamp) -> float | None:
    if body_eph.empty:
        return None
    idx = (body_eph["timestamp"] - t_arrival).abs().idxmin()
    return float(body_eph.loc[idx, "helio_lon_deg"])


def find_coincidences(events: pd.DataFrame, jwst: pd.DataFrame,
                      eph_long: pd.DataFrame) -> pd.DataFrame:
    rows: list[dict] = []
    events = events.dropna(subset=["r_au", "helio_lon_deg"])
    bodies = jwst["body"].unique()
    for body in bodies:
        body_eph = eph_long[eph_long["body"] == body].sort_values("timestamp")
        body_jwst = jwst[jwst["body"] == body].sort_values("timestamp")
        if body_eph.empty or body_jwst.empty:
            continue
        for _, ev in events.iterrows():
            r_psp = float(ev["r_au"])
            t_psp = pd.Timestamp(ev["timestamp"])
            psp_lon = float(ev["helio_lon_deg"])
            t_ev_idx = (body_eph["timestamp"] - t_psp).abs().idxmin()
            r_body = float(body_eph.loc[t_ev_idx, "r_au"])
            if not np.isfinite(r_psp) or not np.isfinite(r_body):
                continue
            dr_km = (r_body - r_psp) * AU_KM
            for mech, v_km_s, t_tol_h in (
                ("wind", V_SW_KM_PER_SEC, T_TOLERANCE_HOURS_WIND),
                ("light", C_KM_PER_SEC, T_TOLERANCE_HOURS_LIGHT),
            ):
                dt_hours = dr_km / v_km_s / 3600.0
                t_arrival = t_psp + pd.Timedelta(hours=dt_hours)
                body_lon_at_arrival = predicted_lon_at_arrival(body_eph, t_arrival)
                if body_lon_at_arrival is None:
                    continue
                psp_lon_advected = (psp_lon - OMEGA_SUN_DEG_PER_DAY * dt_hours / 24.0) \
                                   if mech == "wind" else psp_lon
                delta_lon = float(wrap_180(np.array([
                    psp_lon_advected - body_lon_at_arrival
                ]))[0])
                deltas = (body_jwst["timestamp"] - t_arrival).dt.total_seconds() / 3600.0
                nearest_idx = deltas.abs().idxmin()
                jw = body_jwst.loc[nearest_idx]
                delta_t_h = float(deltas.loc[nearest_idx])
                if abs(delta_t_h) > t_tol_h or abs(delta_lon) > LON_TOLERANCE_DEG:
                    continue
                lon_score = max(0.0, 1.0 - abs(delta_lon) / LON_TOLERANCE_DEG)
                t_score = max(0.0, 1.0 - abs(delta_t_h) / t_tol_h)
                rows.append({
                    "psp_event_timestamp": t_psp,
                    "psp_pvi_tau100s": float(ev.get("pvi_tau100s", np.nan)),
                    "psp_helio_lon_deg": psp_lon,
                    "psp_r_au": r_psp,
                    "mechanism": mech,
                    "v_propagation_km_s": v_km_s,
                    "body": body,
                    "body_r_au": r_body,
                    "predicted_arrival_timestamp": t_arrival,
                    "predicted_body_lon_at_arrival": body_lon_at_arrival,
                    "psp_lon_advected_to_arrival": psp_lon_advected,
                    "delta_lon_deg": delta_lon,
                    "jwst_obs_timestamp": pd.Timestamp(jw["timestamp"]),
                    "jwst_source_file": jw["source_file"],
                    "jwst_filter": jw.get("filter"),
                    "delta_t_hours": delta_t_h,
                    "lon_score": lon_score,
                    "t_score": t_score,
                    "match_score": lon_score * t_score,
                })
    return pd.DataFrame(rows)


def main() -> int:
    if "HF_TOKEN" not in os.environ:
        print("ERROR: HF_TOKEN not set", file=sys.stderr)
        return 1
    token = os.environ["HF_TOKEN"]
    api = HfApi(token=token)
    if PERIHELION not in PERIHELIA:
        print(f"ERROR: unknown perihelion {PERIHELION}", file=sys.stderr)
        return 1

    events = load(token, f"events/psp_candidate_events_{PERIHELION}.parquet")
    jwst = load(token, f"events/jwst_aggregates_{PERIHELION}.parquet")
    eph_long = load(token, f"coords/ephemeris_long_{PERIHELION}.parquet")
    wispr_events = load(token, f"events/wispr_fronts_{PERIHELION}.parquet")
    if events.empty or jwst.empty or eph_long.empty:
        print("[stage-4] missing inputs — events/jwst/ephemeris not all present",
              file=sys.stderr)
        return 1

    events = events.copy()
    events["event_kind"] = "psp_pvi"
    if not wispr_events.empty:
        wispr_events = wispr_events.copy()
        wispr_events["event_kind"] = "wispr_front"
        common = ["timestamp", "r_au", "helio_lon_deg", "helio_lat_deg",
                  "carrington_lon_deg", "pvi_tau100s", "event_kind", "source_file"]
        for c in common:
            if c not in wispr_events.columns:
                wispr_events[c] = np.nan
        events = pd.concat([events[common + [c for c in events.columns if c not in common]],
                             wispr_events[common + [c for c in wispr_events.columns if c not in common]]],
                            ignore_index=True)
        print(f"[stage-4] including {len(wispr_events)} WISPR fronts in event pool")
    events["timestamp"] = pd.to_datetime(events["timestamp"]).dt.tz_localize(None)
    jwst = jwst.copy()
    jwst["timestamp"] = pd.to_datetime(jwst["timestamp"]).dt.tz_localize(None)
    eph_long = eph_long.copy()
    eph_long["timestamp"] = pd.to_datetime(eph_long["timestamp"]).dt.tz_localize(None)

    print(f"[stage-4] {len(events)} PSP candidates × {len(jwst)} JWST obs "
          f"× {eph_long['body'].nunique()} bodies")
    coincidences = find_coincidences(events, jwst, eph_long)

    out_dir = Path("helio_cache/events")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"coincidences_{PERIHELION}.parquet"
    coincidences.to_parquet(out_path, compression="snappy")
    print(f"[stage-4] wrote {len(coincidences)} coincidences to {out_path}")

    summary = {
        "v_sw_km_s": V_SW_KM_PER_SEC,
        "lon_tolerance_deg": LON_TOLERANCE_DEG,
        "t_tolerance_wind_h": T_TOLERANCE_HOURS_WIND,
        "t_tolerance_light_h": T_TOLERANCE_HOURS_LIGHT,
        "n_psp_events": int(len(events)),
        "n_jwst_observations": int(len(jwst)),
        "n_coincidences_total": int(len(coincidences)),
        "by_mechanism": (coincidences["mechanism"].value_counts().to_dict()
                          if not coincidences.empty else {}),
        "by_body": (coincidences["body"].value_counts().to_dict()
                     if not coincidences.empty else {}),
        "by_mechanism_body": ({} if coincidences.empty else
                               coincidences.groupby(["mechanism", "body"])
                               .size().reset_index(name="n")
                               .to_dict(orient="records")),
        "median_match_score": (None if coincidences.empty else
                                float(coincidences["match_score"].median())),
    }
    summary_path = out_dir / f"coincidences_summary_{PERIHELION}.json"
    summary_path.write_text(json.dumps(summary, indent=2, default=str))
    print(f"[stage-4] wrote summary: {summary}")

    push(api, out_path, f"events/coincidences_{PERIHELION}.parquet",
         f"stage-4: PSP event × JWST observation coincidences {PERIHELION}")
    push(api, summary_path, f"events/coincidences_summary_{PERIHELION}.json",
         f"stage-4: coincidence summary {PERIHELION}")
    print("[stage-4] done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
