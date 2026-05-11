#!/usr/bin/env python3
"""
Stage 3b — WISPR brightness-front detection.

WISPR is PSP's wide-field coronagraph; brightness spikes in the L3 image
sequence mark CME fronts crossing the field of view. We don't store raw
image cubes (too big); instead pull.py emits a per-frame brightness summary
(mean, sum, p99) per detector. This stage finds anomalies in that time
series and tags them as candidate CME fronts.

Method: running 51-frame median + MAD-normalised residual on `brightness_sum`.
Threshold residual > 5 (robust z) marks candidate frames. Cluster
consecutive flagged frames (gap < 30 min) into single events; record peak
residual, duration, and the PSP heliographic position via merge_asof on the
PSP ephemeris.

Output: events/wispr_fronts_{PERIHELION}.parquet
Schema matches `events/psp_candidate_events_*` so stage-4 (coincide.py)
can consume both event types interchangeably.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from huggingface_hub import HfApi, hf_hub_download, list_repo_files

from targets import PERIHELIA

REPO_ID = "luuow/meridian-helio-mirror"
PERIHELION = os.environ.get("HELIO_PERIHELION", "E20")
ROLLING_WINDOW = 51
RESIDUAL_THRESHOLD = 5.0
GAP_MINUTES = 30.0


def push(api: HfApi, local: Path, repo_path: str, message: str) -> None:
    api.upload_file(
        path_or_fileobj=str(local),
        path_in_repo=repo_path,
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message=message,
    )


def robust_z(series: pd.Series, window: int = ROLLING_WINDOW) -> pd.Series:
    rolling_median = series.rolling(window, min_periods=8, center=True).median()
    residual = series - rolling_median
    mad = residual.rolling(window, min_periods=8, center=True).apply(
        lambda x: np.median(np.abs(x - np.median(x))), raw=True)
    mad = mad.replace(0, np.nan)
    return residual / (1.4826 * mad)


def load(token: str, name: str) -> pd.DataFrame:
    files = list_repo_files(REPO_ID, repo_type="dataset", token=token)
    if name not in files:
        return pd.DataFrame()
    p = hf_hub_download(repo_id=REPO_ID, repo_type="dataset",
                        filename=name, token=token)
    return pd.read_parquet(p)


def main() -> int:
    if "HF_TOKEN" not in os.environ:
        print("ERROR: HF_TOKEN not set", file=sys.stderr)
        return 1
    token = os.environ["HF_TOKEN"]
    api = HfApi(token=token)
    if PERIHELION not in PERIHELIA:
        print(f"ERROR: unknown perihelion {PERIHELION}", file=sys.stderr)
        return 1

    wispr = load(token, f"psp/wispr_brightness_{PERIHELION}.parquet")
    if wispr.empty:
        print(f"[stage-3b] no WISPR brightness file — skipping")
        return 0
    psp_reg = load(token, f"coords/psp_registered_{PERIHELION}.parquet")

    wispr["time"] = pd.to_datetime(wispr["time"]).dt.tz_localize(None)
    wispr = wispr.sort_values(["detector", "time"]).reset_index(drop=True)

    events_rows: list[dict] = []
    for det, g in wispr.groupby("detector"):
        g = g.sort_values("time").reset_index(drop=True)
        if len(g) < ROLLING_WINDOW // 2:
            print(f"[stage-3b] {det}: only {len(g)} frames, skipping")
            continue
        z = robust_z(g["brightness_sum"])
        flagged = g[z > RESIDUAL_THRESHOLD].copy()
        flagged["robust_z"] = z[z > RESIDUAL_THRESHOLD]
        if flagged.empty:
            print(f"[stage-3b] {det}: no brightness anomalies")
            continue
        flagged["t_s"] = flagged["time"].astype("int64") / 1e9
        flagged = flagged.sort_values("t_s")
        gaps = flagged["t_s"].diff().fillna(0)
        flagged["event_id"] = (gaps > GAP_MINUTES * 60).cumsum()
        agg = flagged.groupby("event_id").agg(
            timestamp=("time", "first"),
            event_end=("time", "last"),
            detector=("detector", "first"),
            peak_robust_z=("robust_z", "max"),
            peak_brightness_sum=("brightness_sum", "max"),
            n_frames=("time", "size"),
        ).reset_index(drop=True)
        agg["duration_sec"] = (agg["event_end"] - agg["timestamp"]).dt.total_seconds()
        events_rows.append(agg)

    if not events_rows:
        print("[stage-3b] no events")
        return 0
    events = pd.concat(events_rows, ignore_index=True)

    if not psp_reg.empty:
        psp_reg = psp_reg.copy()
        psp_reg["timestamp"] = pd.to_datetime(psp_reg["timestamp"]).dt.tz_localize(None)
        pos = psp_reg[["timestamp", "r_au", "helio_lon_deg", "helio_lat_deg",
                       "carrington_lon_deg"]].drop_duplicates("timestamp").sort_values("timestamp")
        events = events.sort_values("timestamp")
        events = pd.merge_asof(
            events, pos, on="timestamp",
            direction="nearest", tolerance=pd.Timedelta("1h"),
        )

    events["source_file"] = f"psp/wispr_brightness_{PERIHELION}.parquet"
    events["pvi_tau100s"] = np.nan
    print(f"[stage-3b] {len(events)} WISPR brightness events")
    print(events.groupby("detector").agg(
        n=("timestamp", "size"),
        peak_z_med=("peak_robust_z", "median"),
        duration_med=("duration_sec", "median"),
    ).to_string())

    out_dir = Path("helio_cache/events")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"wispr_fronts_{PERIHELION}.parquet"
    events.to_parquet(out_path, compression="snappy")
    push(api, out_path, f"events/wispr_fronts_{PERIHELION}.parquet",
         f"stage-3b: WISPR brightness fronts {PERIHELION}")
    print(f"[stage-3b] pushed events/wispr_fronts_{PERIHELION}.parquet")
    return 0


if __name__ == "__main__":
    sys.exit(main())
