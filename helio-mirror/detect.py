#!/usr/bin/env python3
"""
Stage 3 — event detection.

PSP-side:
  Compute Partial Variance of Increments (PVI) on the B-field at lag scales
  τ ∈ {10 s, 100 s, 1000 s}. PVI(τ,t) = |B(t+τ) − B(t)| / √⟨|dB(τ)|²⟩.
  Standard threshold PVI > 3 marks current sheets, rotational discontinuities,
  CME shock fronts — i.e., events worth correlating with downstream reflectance.

JWST-side:
  For each science FITS, compute integrated flux in a central aperture
  (avoiding edge artefacts). Per-band per-body brightness baseline is the
  input to anomaly detection — but with our current sparse cadence we just
  record the per-observation aggregate.

Outputs to `luuow/meridian-helio-mirror`:
  events/psp_pvi_{PERIHELION}.parquet            — full PVI time series at τ=100s
  events/psp_candidate_events_{PERIHELION}.parquet — rows where PVI > threshold
  events/jwst_aggregates_{PERIHELION}.parquet    — per-FITS integrated flux
"""
from __future__ import annotations

import os
import sys
import traceback
from pathlib import Path

import numpy as np
import pandas as pd
from astropy.io import fits
from huggingface_hub import HfApi, hf_hub_download, list_repo_files

from gates import Gate
from targets import PERIHELIA, SPACECRAFT

REPO_ID = "luuow/meridian-helio-mirror"
PERIHELION = os.environ.get("HELIO_PERIHELION", "E20")

PVI_LAGS_SEC = (10, 100, 1000)
PVI_REF_LAG_SEC = 100
# Threshold default = 3 (standard literature value). Raise to 5+ via
# HELIO_PVI_THRESHOLD env var to drop event density and escape the
# null-saturation regime documented in ROADMAP item 0a.
PVI_THRESHOLD = float(os.environ.get("HELIO_PVI_THRESHOLD", "3.0"))
PVI_WINDOW_SAMPLES = 4096


def push(api: HfApi, local: Path, repo_path: str, message: str) -> None:
    from hf_push import push as _push
    _push(api, REPO_ID, local, repo_path, message)


def compute_pvi(b_vec: np.ndarray, dt_sec: float, lag_sec: float) -> np.ndarray:
    """PVI at fixed lag, normalised by a rolling-window stdev of |dB|."""
    lag = max(1, int(round(lag_sec / dt_sec)))
    dB = b_vec[lag:] - b_vec[:-lag]
    mag = np.linalg.norm(dB, axis=1) if dB.ndim == 2 else np.abs(dB)
    rolling = pd.Series(mag ** 2).rolling(PVI_WINDOW_SAMPLES, min_periods=64).mean()
    denom = np.sqrt(rolling.to_numpy())
    pvi = np.full_like(mag, np.nan)
    valid = denom > 0
    pvi[valid] = mag[valid] / denom[valid]
    return np.pad(pvi, (0, lag), constant_values=np.nan)


def estimate_dt_sec(timestamps: pd.Series) -> float:
    t = timestamps.astype("int64").to_numpy() / 1e9
    diffs = np.diff(t)
    diffs = diffs[(diffs > 0) & (diffs < 10.0)]
    return float(np.median(diffs)) if diffs.size else 0.218453


def detect_psp_events(token: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    psp_reg = f"coords/psp_registered_{PERIHELION}.parquet"
    files = list_repo_files(REPO_ID, repo_type="dataset", token=token)
    if psp_reg not in files:
        print(f"[stage-3/psp] missing {psp_reg} — run stage-2 first",
              file=sys.stderr)
        return pd.DataFrame(), pd.DataFrame()

    path = hf_hub_download(repo_id=REPO_ID, repo_type="dataset",
                           filename=psp_reg, token=token)
    df = pd.read_parquet(path).sort_values("timestamp").reset_index(drop=True)
    dt_sec = estimate_dt_sec(df["timestamp"])
    b = df[["B_R", "B_T", "B_N"]].to_numpy()
    print(f"[stage-3/psp] {len(df)} samples, dt≈{dt_sec:.4f}s")

    pvi_cols: dict[str, np.ndarray] = {}
    for lag in PVI_LAGS_SEC:
        pvi_cols[f"pvi_tau{lag}s"] = compute_pvi(b, dt_sec, lag)
    pvi_df = pd.concat(
        [df[["timestamp", "source_file", "r_au",
             "helio_lon_deg", "helio_lat_deg", "carrington_lon_deg"]].reset_index(drop=True),
         pd.DataFrame(pvi_cols)],
        axis=1,
    )

    ref_col = f"pvi_tau{PVI_REF_LAG_SEC}s"
    above = pvi_df[pvi_df[ref_col] > PVI_THRESHOLD].copy()
    above = above.dropna(subset=["r_au", "helio_lon_deg"])
    above = above.sort_values("timestamp").reset_index(drop=True)
    print(f"[stage-3/psp] PVI>{PVI_THRESHOLD} at τ={PVI_REF_LAG_SEC}s: "
          f"{len(above)} raw samples")
    if above.empty:
        return pvi_df, above
    above["t_s"] = above["timestamp"].astype("int64") / 1e9
    EVENT_GAP_SEC = 60.0
    gaps = above["t_s"].diff().fillna(0)
    above["event_id"] = (gaps > EVENT_GAP_SEC).cumsum()
    grouped = above.groupby("event_id").agg(
        timestamp=("timestamp", "first"),
        event_end=("timestamp", "last"),
        source_file=("source_file", "first"),
        r_au=("r_au", "mean"),
        helio_lon_deg=("helio_lon_deg", "mean"),
        helio_lat_deg=("helio_lat_deg", "mean"),
        carrington_lon_deg=("carrington_lon_deg", "mean"),
        pvi_tau10s=("pvi_tau10s", "max"),
        pvi_tau100s=("pvi_tau100s", "max"),
        pvi_tau1000s=("pvi_tau1000s", "max"),
        n_samples=("timestamp", "size"),
    ).reset_index(drop=True)
    grouped["duration_sec"] = (grouped["event_end"] - grouped["timestamp"]).dt.total_seconds()
    candidates = grouped
    print(f"[stage-3/psp] clustered into {len(candidates)} events "
          f"(gap > {EVENT_GAP_SEC}s); median peak PVI100 "
          f"{candidates['pvi_tau100s'].median():.2f}")
    return pvi_df, candidates


def detect_probe_events(token: str) -> pd.DataFrame:
    """Run the same PVI + clustering pipeline as PSP, but for every HSO probe
    that landed in coords/probes_registered_*. PVI on |dB| works on any RTN
    magnetometer regardless of mission.

    Returns rows compatible with psp_candidate_events_* plus a `spacecraft`
    column so stage-4 can pull them all into a single event pool.
    """
    reg_path = f"coords/probes_registered_{PERIHELION}.parquet"
    files = list_repo_files(REPO_ID, repo_type="dataset", token=token)
    if reg_path not in files:
        print(f"[stage-3/probes] missing {reg_path} — skipping HSO events",
              file=sys.stderr)
        return pd.DataFrame()
    path = hf_hub_download(repo_id=REPO_ID, repo_type="dataset",
                            filename=reg_path, token=token)
    df = pd.read_parquet(path)
    df["timestamp"] = pd.to_datetime(df["timestamp"]).dt.tz_localize(None)

    all_events: list[pd.DataFrame] = []
    for sc, g in df.groupby("spacecraft"):
        g = g.sort_values("timestamp").reset_index(drop=True)
        if len(g) < 64:
            print(f"[stage-3/probes] {sc}: {len(g)} samples, skipping")
            continue
        dt_sec = estimate_dt_sec(g["timestamp"])
        b = g[["B_R", "B_T", "B_N"]].to_numpy()
        pvi_cols = {f"pvi_tau{lag}s": compute_pvi(b, dt_sec, lag) for lag in PVI_LAGS_SEC}
        sc_pvi = pd.concat([g[["timestamp", "spacecraft", "r_au", "helio_lon_deg",
                                "helio_lat_deg", "carrington_lon_deg"]].reset_index(drop=True),
                             pd.DataFrame(pvi_cols)], axis=1)
        ref_col = f"pvi_tau{PVI_REF_LAG_SEC}s"
        above = sc_pvi[sc_pvi[ref_col] > PVI_THRESHOLD].copy().dropna(
            subset=["r_au", "helio_lon_deg"])
        if above.empty:
            print(f"[stage-3/probes] {sc}: 0 PVI>{PVI_THRESHOLD} samples")
            continue
        above = above.sort_values("timestamp").reset_index(drop=True)
        above["t_s"] = above["timestamp"].astype("int64") / 1e9
        gaps = above["t_s"].diff().fillna(0)
        EVENT_GAP_SEC = 60.0
        above["event_id"] = (gaps > EVENT_GAP_SEC).cumsum()
        grouped = above.groupby("event_id").agg(
            timestamp=("timestamp", "first"),
            event_end=("timestamp", "last"),
            spacecraft=("spacecraft", "first"),
            r_au=("r_au", "mean"),
            helio_lon_deg=("helio_lon_deg", "mean"),
            helio_lat_deg=("helio_lat_deg", "mean"),
            carrington_lon_deg=("carrington_lon_deg", "mean"),
            pvi_tau10s=("pvi_tau10s", "max"),
            pvi_tau100s=("pvi_tau100s", "max"),
            pvi_tau1000s=("pvi_tau1000s", "max"),
            n_samples=("timestamp", "size"),
        ).reset_index(drop=True)
        grouped["duration_sec"] = (grouped["event_end"] - grouped["timestamp"]).dt.total_seconds()
        grouped["source_file"] = f"probes/{sc}_mag_{PERIHELION}.parquet"
        all_events.append(grouped)
        print(f"[stage-3/probes] {sc}: clustered {len(grouped)} events, "
              f"median peak PVI100 {grouped['pvi_tau100s'].median():.2f}")

    if not all_events:
        return pd.DataFrame()
    out = pd.concat(all_events, ignore_index=True)
    print(f"[stage-3/probes] total HSO events: {len(out)}")
    return out


def jwst_aggregate(local_path: Path) -> dict | None:
    try:
        with fits.open(local_path) as hdul:
            sci_hdus = [h for h in hdul
                        if h.name == "SCI" and h.data is not None and h.data.ndim >= 2]
            if not sci_hdus:
                return None
            data = sci_hdus[0].data
            hdr = sci_hdus[0].header
            primary = hdul[0].header
        if data.ndim > 2:
            data = data.sum(axis=tuple(range(data.ndim - 2)))
        h, w = data.shape
        pad_h, pad_w = h // 10, w // 10
        core = data[pad_h:h - pad_h, pad_w:w - pad_w]
        valid = np.isfinite(core)
        if valid.sum() == 0:
            return None
        return {
            "n_pix_valid": int(valid.sum()),
            "flux_sum": float(np.nansum(core)),
            "flux_mean": float(np.nanmean(core)),
            "flux_median": float(np.nanmedian(core)),
            "flux_p99": float(np.nanpercentile(core, 99)),
            "bunit": str(hdr.get("BUNIT") or primary.get("BUNIT") or ""),
            "extname": sci_hdus[0].name,
        }
    except Exception as e:
        print(f"[stage-3/jwst] {local_path.name}: {e}", file=sys.stderr)
        return None


def aggregate_jwst(token: str) -> pd.DataFrame:
    reg = f"coords/jwst_registered_{PERIHELION}.parquet"
    files = list_repo_files(REPO_ID, repo_type="dataset", token=token)
    if reg not in files:
        print(f"[stage-3/jwst] missing {reg}", file=sys.stderr)
        return pd.DataFrame()
    path = hf_hub_download(repo_id=REPO_ID, repo_type="dataset",
                           filename=reg, token=token)
    df = pd.read_parquet(path)
    rows = []
    for _, r in df.iterrows():
        try:
            f = r["source_file"]
            local = Path(hf_hub_download(repo_id=REPO_ID, repo_type="dataset",
                                          filename=f, token=token))
            agg = jwst_aggregate(local)
            if agg is None:
                continue
            rec = r.to_dict() | agg
            rows.append(rec)
        except Exception as e:
            print(f"[stage-3/jwst] {r['source_file']}: {e}", file=sys.stderr)
            traceback.print_exc()
    out = pd.DataFrame(rows)
    if not out.empty:
        print(f"[stage-3/jwst] {len(out)} aggregates")
        print(out.groupby("body")[["instrument", "filter", "flux_sum"]]
              .agg({"instrument": lambda s: s.value_counts().to_dict(),
                    "filter": lambda s: s.value_counts().to_dict(),
                    "flux_sum": "median"}).to_string())
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
    print(f"[stage-3] perihelion={PERIHELION}")

    with Gate("detect", PERIHELION, REPO_ID, api=api) as g:
        rc = _main_inner(token, api, g)
    return rc


def _main_inner(token: str, api: HfApi, gate: Gate) -> int:
    out_dir = Path("helio_cache/events")
    out_dir.mkdir(parents=True, exist_ok=True)

    pvi_df, candidates = detect_psp_events(token)
    if not pvi_df.empty:
        pvi_df.to_parquet(out_dir / f"psp_pvi_{PERIHELION}.parquet", compression="snappy")
    if not candidates.empty:
        candidates.to_parquet(
            out_dir / f"psp_candidate_events_{PERIHELION}.parquet", compression="snappy")

    probe_events = detect_probe_events(token)
    if not probe_events.empty:
        probe_events.to_parquet(
            out_dir / f"probe_candidate_events_{PERIHELION}.parquet", compression="snappy")

    jwst_agg = aggregate_jwst(token)
    if not jwst_agg.empty:
        jwst_agg.to_parquet(
            out_dir / f"jwst_aggregates_{PERIHELION}.parquet", compression="snappy")

    from hf_push import push_folder
    push_folder(api, REPO_ID, out_dir, "events",
                 f"stage-3: detected events {PERIHELION}",
                 allow_patterns=[f"*_{PERIHELION}.parquet"])
    print(f"[stage-3] pushed events/ for {PERIHELION} as one commit")

    print("[stage-3] done.")
    gate.n_inputs = int(len(pvi_df)) if not pvi_df.empty else 0
    gate.n_outputs = int(
        (0 if candidates.empty else len(candidates))
        + (0 if probe_events.empty else len(probe_events))
    )
    gate.notes = {
        "n_psp_events": 0 if candidates.empty else int(len(candidates)),
        "n_probe_events_total": 0 if probe_events.empty else int(len(probe_events)),
        "n_probes_with_events": (0 if probe_events.empty
                                    else int(probe_events["spacecraft"].nunique())),
        "n_jwst_aggregates": 0 if jwst_agg.empty else int(len(jwst_agg)),
    }
    return 0


if __name__ == "__main__":
    sys.exit(main())
