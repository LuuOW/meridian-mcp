#!/usr/bin/env python3
"""
Stage 3c — SEP onset detection from ISOIS/EPI-Hi.

A solar energetic particle event shows up in EPI-Hi as a multi-decade jump
in integrated proton rate above the perihelion-quiet background. Same
robust-z approach as detect_wispr: rolling median + MAD-normalised residual,
threshold at z > 5, cluster on 30-min gaps.

Output schema matches `events/psp_candidate_events_*` so coincide.py can
ingest these alongside PVI and WISPR events.

Output: events/psp_sep_onsets_{PERIHELION}.parquet
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
ROLLING_WINDOW = 101
RESIDUAL_THRESHOLD = 5.0
GAP_MINUTES = 30.0


def push(api: HfApi, local: Path, repo_path: str, message: str) -> None:
    from hf_push import push as _push
    _push(api, REPO_ID, local, repo_path, message)


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

    isois = load(token, f"psp/isois_epihi_{PERIHELION}.parquet")
    if isois.empty:
        print("[stage-3c] no ISOIS EPI-Hi file — skipping")
        return 0
    psp_reg = load(token, f"coords/psp_registered_{PERIHELION}.parquet")

    isois["time"] = pd.to_datetime(isois["time"]).dt.tz_localize(None)
    isois = isois.sort_values("time").reset_index(drop=True)
    if len(isois) < ROLLING_WINDOW // 2:
        print(f"[stage-3c] only {len(isois)} samples, skipping")
        return 0

    z = robust_z(isois["proton_rate"])
    flagged = isois[z > RESIDUAL_THRESHOLD].copy()
    flagged["robust_z"] = z[z > RESIDUAL_THRESHOLD]
    if flagged.empty:
        print(f"[stage-3c] no SEP onsets above z={RESIDUAL_THRESHOLD}")
        return 0
    flagged["t_s"] = flagged["time"].astype("int64") / 1e9
    gaps = flagged["t_s"].diff().fillna(0)
    flagged["event_id"] = (gaps > GAP_MINUTES * 60).cumsum()
    events = flagged.groupby("event_id").agg(
        timestamp=("time", "first"),
        event_end=("time", "last"),
        peak_robust_z=("robust_z", "max"),
        peak_proton_rate=("proton_rate", "max"),
        integrated_proton_rate=("proton_rate", "sum"),
        n_samples=("time", "size"),
    ).reset_index(drop=True)
    events["duration_sec"] = (events["event_end"] - events["timestamp"]).dt.total_seconds()

    if not psp_reg.empty:
        psp_reg = psp_reg.copy()
        psp_reg["timestamp"] = pd.to_datetime(psp_reg["timestamp"]).dt.tz_localize(None)
        pos = psp_reg[["timestamp", "r_au", "helio_lon_deg", "helio_lat_deg",
                       "carrington_lon_deg"]].drop_duplicates("timestamp").sort_values("timestamp")
        events = events.sort_values("timestamp")
        events = pd.merge_asof(events, pos, on="timestamp",
                                direction="nearest", tolerance=pd.Timedelta("1h"))

    events["source_file"] = f"psp/isois_epihi_{PERIHELION}.parquet"
    events["pvi_tau100s"] = np.nan
    print(f"[stage-3c] {len(events)} SEP onset events")

    out_dir = Path("helio_cache/events")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"psp_sep_onsets_{PERIHELION}.parquet"
    events.to_parquet(out_path, compression="snappy")
    push(api, out_path, f"events/psp_sep_onsets_{PERIHELION}.parquet",
         f"stage-3c: PSP SEP onsets {PERIHELION}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
