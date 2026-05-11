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

from gates import Gate
from targets import PERIHELIA, SPACECRAFT

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
    from hf_push import push as _push
    _push(api, REPO_ID, local, repo_path, message)


def wrap_180(deg: np.ndarray) -> np.ndarray:
    return ((deg + 180.0) % 360.0) - 180.0


def load(token: str, name: str) -> pd.DataFrame:
    files = list_repo_files(REPO_ID, repo_type="dataset", token=token)
    if name not in files:
        print(f"[stage-4] missing {name}", file=sys.stderr)
        return pd.DataFrame()
    p = hf_hub_download(repo_id=REPO_ID, repo_type="dataset", filename=name, token=token)
    return pd.read_parquet(p)


def attach_per_event_vsw(events: pd.DataFrame, token: str) -> pd.DataFrame:
    """For each event, look up v_sw from plasma/{sc}_speed_{P}.parquet via
    nearest-time match (±2 h tolerance). Adds a `v_sw_km_s` column; rows
    without plasma coverage get NaN and fall back to V_SW_KM_PER_SEC
    in find_probe_coincidences."""
    files = list_repo_files(REPO_ID, repo_type="dataset", token=token)
    if "spacecraft" not in events.columns:
        return events.copy()
    out = events.copy()
    out["v_sw_km_s"] = np.nan
    out = out.reset_index(drop=False).rename(columns={"index": "__orig_idx__"})
    for sc in out["spacecraft"].dropna().unique():
        safe = sc.replace("/", "_").replace(" ", "_")
        name = f"plasma/{safe}_speed_{PERIHELION}.parquet"
        if name not in files:
            continue
        try:
            p = hf_hub_download(repo_id=REPO_ID, repo_type="dataset",
                                 filename=name, token=token)
            plasma = pd.read_parquet(p)
            if plasma.empty:
                continue
            plasma = plasma.copy()
            plasma["time"] = pd.to_datetime(plasma["time"]).dt.tz_localize(None)
            plasma = plasma[["time", "v_sw_km_s"]].rename(
                columns={"v_sw_km_s": "v_sw_km_s_plasma"}).sort_values("time")
            mask = out["spacecraft"] == sc
            ev_sub = out.loc[mask].sort_values("timestamp")
            joined = pd.merge_asof(
                ev_sub, plasma,
                left_on="timestamp", right_on="time",
                direction="nearest", tolerance=pd.Timedelta("2h"),
            )
            # joined retains __orig_idx__ from ev_sub; use it to write back
            for idx, v in zip(joined["__orig_idx__"], joined["v_sw_km_s_plasma"]):
                if pd.notna(v):
                    out.loc[out["__orig_idx__"] == idx, "v_sw_km_s"] = float(v)
            n_attached = joined["v_sw_km_s_plasma"].notna().sum()
            print(f"[stage-4/vsw] {sc}: attached v_sw to {int(n_attached)}/{int(mask.sum())} events "
                  f"(plasma median {plasma['v_sw_km_s_plasma'].median():.0f} km/s)")
        except Exception as e:
            print(f"[stage-4/vsw] {sc}: {e}", file=sys.stderr)
    out = out.drop(columns="__orig_idx__")
    return out


def predicted_lon_at_arrival(body_eph: pd.DataFrame, t_arrival: pd.Timestamp) -> float | None:
    if body_eph.empty:
        return None
    idx = (body_eph["timestamp"] - t_arrival).abs().idxmin()
    return float(body_eph.loc[idx, "helio_lon_deg"])


def find_probe_coincidences(events: pd.DataFrame,
                              eph_long: pd.DataFrame) -> pd.DataFrame:
    """HSO multi-probe matching, vectorized.

    Was an O(N_events × N_eph) Python iterrows loop — 3+ min per null_test
    shuffle. Now batched merge_asof per (src, tgt) pair: src events as a
    numpy frame, three merge_asof joins for (r_tgt, lon_tgt_at_src,
    lon_tgt_at_arrival, nearest_target_event). Same output schema.

    Per-event v_sw: if a `v_sw_km_s` column is present on source events,
    use it; otherwise fall back to V_SW_KM_PER_SEC constant.

    Drops self-pairs and any pair where target ephemeris is missing.
    """
    if events.empty:
        return pd.DataFrame()
    spacecrafts = events["spacecraft"].dropna().unique().tolist()
    if len(spacecrafts) < 2:
        return pd.DataFrame()
    events = events.dropna(subset=["r_au", "helio_lon_deg", "spacecraft"]).copy()
    events["timestamp"] = pd.to_datetime(events["timestamp"]).dt.tz_localize(None)
    if "v_sw_km_s" not in events.columns:
        events["v_sw_km_s"] = np.nan
    if "pvi_tau100s" not in events.columns:
        events["pvi_tau100s"] = np.nan

    chunks: list[pd.DataFrame] = []
    eph_long = eph_long.copy()
    eph_long["timestamp"] = pd.to_datetime(eph_long["timestamp"]).dt.tz_localize(None)

    for src in spacecrafts:
        src_events = events[events["spacecraft"] == src].copy()
        if src_events.empty:
            continue
        src_events = src_events.sort_values("timestamp").reset_index(drop=True)
        for tgt in spacecrafts:
            if tgt == src:
                continue
            tgt_eph = eph_long[eph_long["body"] == tgt].sort_values("timestamp")
            if tgt_eph.empty:
                continue
            tgt_events = events[events["spacecraft"] == tgt].sort_values("timestamp")

            # 1) For each src event, get r_tgt at t_src via merge_asof
            df = src_events[["timestamp", "r_au", "helio_lon_deg", "v_sw_km_s",
                              "pvi_tau100s"]].rename(columns={
                "r_au": "source_r_au",
                "helio_lon_deg": "source_lon_deg",
                "pvi_tau100s": "source_event_pvi",
            })
            df = pd.merge_asof(
                df, tgt_eph[["timestamp", "r_au"]].rename(columns={"r_au": "target_r_au"}),
                on="timestamp", direction="nearest",
            )

            # Compute v_sw (with fallback) and dt_h
            df["v_sw_km_s"] = df["v_sw_km_s"].fillna(V_SW_KM_PER_SEC)
            valid = np.isfinite(df["source_r_au"]) & np.isfinite(df["target_r_au"])
            df = df[valid].reset_index(drop=True)
            if df.empty:
                continue
            dr_km = (df["target_r_au"] - df["source_r_au"]) * AU_KM
            df["advection_lead_hours"] = dr_km / df["v_sw_km_s"] / 3600.0
            df["advection_v_sw_km_s"] = df["v_sw_km_s"]
            df = df[df["advection_lead_hours"] >= 0].reset_index(drop=True)  # target outside
            if df.empty:
                continue
            df["predicted_arrival_timestamp"] = df["timestamp"] + pd.to_timedelta(
                df["advection_lead_hours"], unit="h")

            # 2) lon_tgt_at_arrival via merge_asof on predicted_arrival_timestamp
            df = df.sort_values("predicted_arrival_timestamp").reset_index(drop=True)
            df = pd.merge_asof(
                df, tgt_eph[["timestamp", "helio_lon_deg"]].rename(columns={
                    "helio_lon_deg": "target_lon_at_arrival_deg",
                    "timestamp": "_eph_ts"}),
                left_on="predicted_arrival_timestamp", right_on="_eph_ts",
                direction="nearest",
            ).drop(columns="_eph_ts")

            # 3) Vectorized lon-spiral check
            lon_src_advected = df["source_lon_deg"] - OMEGA_SUN_DEG_PER_DAY * df["advection_lead_hours"] / 24.0
            d_lon = ((lon_src_advected - df["target_lon_at_arrival_deg"] + 180) % 360) - 180
            df["delta_lon_deg"] = d_lon
            df = df[d_lon.abs() <= LON_TOLERANCE_DEG].reset_index(drop=True)
            if df.empty:
                continue

            # 4) Nearest target event around predicted_arrival via merge_asof
            if tgt_events.empty:
                df["matched"] = False
                df["nearest_target_event_dt_hours"] = np.nan
                df["nearest_target_event_pvi"] = np.nan
                df["nearest_target_event_timestamp"] = pd.NaT
            else:
                tgt_e = tgt_events[["timestamp", "pvi_tau100s"]].rename(columns={
                    "timestamp": "_tgt_ts",
                    "pvi_tau100s": "nearest_target_event_pvi",
                }).sort_values("_tgt_ts")
                df = df.sort_values("predicted_arrival_timestamp").reset_index(drop=True)
                df = pd.merge_asof(
                    df, tgt_e,
                    left_on="predicted_arrival_timestamp", right_on="_tgt_ts",
                    direction="nearest",
                )
                df["nearest_target_event_dt_hours"] = (
                    (df["_tgt_ts"] - df["predicted_arrival_timestamp"])
                    .dt.total_seconds() / 3600.0
                )
                df["matched"] = df["nearest_target_event_dt_hours"].abs() <= T_TOLERANCE_HOURS_WIND
                df["nearest_target_event_timestamp"] = df["_tgt_ts"]
                df = df.drop(columns="_tgt_ts")

            df["source_spacecraft"] = src
            df["target_spacecraft"] = tgt
            df = df.rename(columns={"timestamp": "source_event_timestamp"})
            chunks.append(df[[
                "source_spacecraft", "target_spacecraft",
                "source_event_timestamp", "source_event_pvi",
                "source_r_au", "source_lon_deg",
                "target_r_au", "target_lon_at_arrival_deg",
                "predicted_arrival_timestamp",
                "advection_lead_hours", "advection_v_sw_km_s",
                "delta_lon_deg",
                "matched",
                "nearest_target_event_dt_hours",
                "nearest_target_event_pvi",
                "nearest_target_event_timestamp",
            ]])

    if not chunks:
        return pd.DataFrame()
    out = pd.concat(chunks, ignore_index=True)
    out["lon_score"] = 1.0 - out["delta_lon_deg"].abs() / LON_TOLERANCE_DEG
    out["t_score"] = (1.0 - out["nearest_target_event_dt_hours"].abs() / T_TOLERANCE_HOURS_WIND).clip(0, 1)
    out["match_score"] = (out["lon_score"] * out["t_score"]).where(out["matched"], 0.0)
    return out


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

    with Gate("coincide", PERIHELION, REPO_ID, api=api) as g:
        rc = _main_inner(token, api, g)
    return rc


def _main_inner(token: str, api: HfApi, gate: Gate) -> int:
    events = load(token, f"events/psp_candidate_events_{PERIHELION}.parquet")
    jwst = load(token, f"events/jwst_aggregates_{PERIHELION}.parquet")
    eph_long = load(token, f"coords/ephemeris_long_{PERIHELION}.parquet")
    wispr_events = load(token, f"events/wispr_fronts_{PERIHELION}.parquet")
    sep_events = load(token, f"events/psp_sep_onsets_{PERIHELION}.parquet")
    probe_events = load(token, f"events/probe_candidate_events_{PERIHELION}.parquet")
    if events.empty or eph_long.empty:
        print("[stage-4] missing inputs — events/ephemeris not present",
              file=sys.stderr)
        return 1
    if jwst.empty:
        print("[stage-4] no JWST aggregates this perihelion; JWST half disabled")

    events = events.copy()
    events["event_kind"] = "psp_pvi"
    events["spacecraft"] = "PSP"
    extra_chunks: list[pd.DataFrame] = []
    common = ["timestamp", "spacecraft", "r_au", "helio_lon_deg", "helio_lat_deg",
              "carrington_lon_deg", "pvi_tau100s", "event_kind", "source_file"]
    for tag, extra, sc_default in (
        ("wispr_front", wispr_events, "PSP"),
        ("sep_onset", sep_events, "PSP"),
        ("probe_pvi", probe_events, None),
    ):
        if extra.empty:
            continue
        extra = extra.copy()
        extra["event_kind"] = tag
        if "spacecraft" not in extra.columns and sc_default is not None:
            extra["spacecraft"] = sc_default
        for c in common:
            if c not in extra.columns:
                extra[c] = np.nan
        extra_chunks.append(extra[common + [c for c in extra.columns if c not in common]])
        print(f"[stage-4] including {len(extra)} {tag} events in pool")
    if extra_chunks:
        events = pd.concat([events[common + [c for c in events.columns if c not in common]]]
                             + extra_chunks, ignore_index=True)
    events["timestamp"] = pd.to_datetime(events["timestamp"]).dt.tz_localize(None)
    jwst = jwst.copy()
    jwst["timestamp"] = pd.to_datetime(jwst["timestamp"]).dt.tz_localize(None)
    eph_long = eph_long.copy()
    eph_long["timestamp"] = pd.to_datetime(eph_long["timestamp"]).dt.tz_localize(None)

    print(f"[stage-4] event pool: {len(events)} events across "
          f"{events['spacecraft'].nunique()} spacecraft, "
          f"{len(jwst)} JWST obs, {eph_long['body'].nunique()} bodies")
    # Attach per-event v_sw from plasma data when available, falling back to
    # V_SW_KM_PER_SEC where missing. This is what (we hope) flips the 4/5
    # negative-z perihelia to positive.
    events = attach_per_event_vsw(events, token)
    n_with_vsw = int(events["v_sw_km_s"].notna().sum()) if "v_sw_km_s" in events.columns else 0
    print(f"[stage-4] {n_with_vsw}/{len(events)} events have per-event v_sw "
          f"(rest fall back to {V_SW_KM_PER_SEC} km/s)")
    coincidences = find_coincidences(events, jwst, eph_long)
    probe_coincidences = find_probe_coincidences(events, eph_long)
    print(f"[stage-4] probe×probe coincidences: {len(probe_coincidences)}")

    out_dir = Path("helio_cache/events")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"coincidences_{PERIHELION}.parquet"
    coincidences.to_parquet(out_path, compression="snappy")
    if not probe_coincidences.empty:
        probe_coincidences.to_parquet(
            out_dir / f"probe_coincidences_{PERIHELION}.parquet",
            compression="snappy")
    print(f"[stage-4] wrote {len(coincidences)} JWST-coincidences + "
          f"{len(probe_coincidences)} probe-coincidences to {out_dir}")

    probe_matched = (probe_coincidences[probe_coincidences["matched"]]
                       if not probe_coincidences.empty else pd.DataFrame())
    # Diagnostic: what v_sw values did the model actually use?
    if not probe_coincidences.empty and "advection_v_sw_km_s" in probe_coincidences.columns:
        median_v_sw_used = float(probe_coincidences["advection_v_sw_km_s"].median())
        n_real_vsw = int((probe_coincidences["advection_v_sw_km_s"] != V_SW_KM_PER_SEC).sum())
    else:
        median_v_sw_used = V_SW_KM_PER_SEC
        n_real_vsw = 0
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
        "n_probe_pairs_candidate": int(len(probe_coincidences)),
        "n_probe_pairs_matched": int(len(probe_matched)),
        "probe_pairs_by_pair": (
            {} if probe_matched.empty else
            probe_matched.groupby(["source_spacecraft", "target_spacecraft"])
            .size().reset_index(name="n").to_dict(orient="records")),
        "median_probe_match_score": (None if probe_matched.empty else
                                       float(probe_matched["match_score"].median())),
        "median_v_sw_km_s_used": median_v_sw_used,
        "n_events_with_real_v_sw": n_real_vsw,
        "v_sw_default_km_s": V_SW_KM_PER_SEC,
    }
    summary_path = out_dir / f"coincidences_summary_{PERIHELION}.json"
    summary_path.write_text(json.dumps(summary, indent=2, default=str))
    print(f"[stage-4] wrote summary: {summary}")

    from hf_push import push_folder
    push_folder(api, REPO_ID, out_dir, "events",
                 f"stage-4: coincidences + summary {PERIHELION}",
                 allow_patterns=[f"coincidences_{PERIHELION}.parquet",
                                  f"probe_coincidences_{PERIHELION}.parquet",
                                  f"coincidences_summary_{PERIHELION}.json"])
    print(f"[stage-4] pushed events/ coincidences for {PERIHELION} as one commit")

    gate.n_inputs = int(len(events))
    gate.n_outputs = int(len(coincidences) + len(probe_coincidences))
    gate.notes = {
        "n_psp_events": int(len(events)),
        "n_jwst_observations": int(len(jwst)),
        "n_coincidences_jwst": int(len(coincidences)),
        "n_probe_pairs_candidate": int(len(probe_coincidences)),
        "n_probe_pairs_matched": int(probe_coincidences["matched"].sum())
            if not probe_coincidences.empty else 0,
        "median_probe_match_score": (None if probe_matched.empty
                                       else float(probe_matched["match_score"].median())),
    }
    if gate.n_outputs == 0:
        gate.reason = "0 coincidences (expected at low data volume; not a stage failure)"
    return 0


if __name__ == "__main__":
    sys.exit(main())
