#!/usr/bin/env python3
"""
Pull a minimal first batch of PSP + JWST data and push to the HF Dataset
LuuOW/meridian-stellar-cache.

Designed for GitHub Actions free tier. Total disk footprint < 200 MB.

PSP:  one day of FIELDS mag_rtn_4_per_cycle (low-cadence summary product)
JWST: TRAPPIST-1 calibrated 1D spectra (x1d) from MAST, capped at 5 files

The first run creates the HF dataset; subsequent runs upload incrementally.
HF auth via env var HF_TOKEN.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

WORK = Path("stellar_cache")
PSP_OUT = WORK / "psp"
JWST_OUT = WORK / "jwst"

# Multi-perihelion PSP plan: 5-day windows spanning E20–E24 plus cruise samples.
# Each range gets pyspedas-downloaded, then split per UTC day into one Parquet
# file. The download is idempotent — re-running overwrites the same paths.
PSP_DATE_RANGES = [
    # E20 perihelion (2024-06-30, ~6.0 R_sun)
    ["2024-06-28", "2024-07-03"],
    # E21 perihelion (2024-09-30, ~9.86 R_sun) — already in cache, will overwrite
    ["2024-09-28", "2024-10-03"],
    # E22 perihelion (2024-12-24)
    ["2024-12-22", "2024-12-27"],
    # E23 perihelion (2025-03-22)
    ["2025-03-20", "2025-03-25"],
    # E24 perihelion (2025-06-19)
    ["2025-06-17", "2025-06-22"],
    # Cruise / quiet baselines for archetype contrast
    ["2024-08-15", "2024-08-16"],
    ["2024-11-10", "2024-11-11"],
    ["2025-02-01", "2025-02-02"],
]

JWST_TARGET = "TRAPPIST-1"
JWST_OBS_CAP = 3
JWST_FILE_CAP = 5

REPO_ID = "luuow/meridian-stellar-cache"


def pull_psp_fields() -> bool:
    """Pull each configured PSP range, split per UTC day, write one Parquet/day."""
    import pyspedas
    from pytplot import get_data, del_data
    import pandas as pd

    var = "psp_fld_l2_mag_RTN_4_Sa_per_Cyc"
    written = 0

    for trange in PSP_DATE_RANGES:
        try:
            del_data("*")  # clear pytplot state between ranges
            pyspedas.psp.fields(
                trange=trange,
                datatype="mag_rtn_4_per_cycle",
                level="l2",
                time_clip=True,
                notplot=False,
            )
            data = get_data(var)
            if data is None:
                print(f"[PSP] {trange[0]}..{trange[1]}: no data", file=sys.stderr)
                continue
            df = pd.DataFrame(
                {
                    "time": pd.to_datetime(data.times, unit="s"),
                    "B_R": data.y[:, 0],
                    "B_T": data.y[:, 1],
                    "B_N": data.y[:, 2],
                }
            )
            for day, group in df.groupby(df["time"].dt.date):
                if len(group) < 1000:
                    continue
                out = PSP_OUT / f"fields_mag_rtn_{day.isoformat()}.parquet"
                group.to_parquet(out, compression="snappy")
                written += 1
                print(f"[PSP] wrote {out} ({len(group)} rows)")
        except Exception as e:
            print(f"[PSP] range {trange} failed: {e}", file=sys.stderr)

    print(f"[PSP] total daily files written: {written}")
    return written > 0


def pull_jwst_trappist1() -> bool:
    from astroquery.mast import Observations

    # calib_level=3 targets Level 3 combined / extracted observation entries —
    # the ones whose primary product is _x1dints.fits / _x1d.fits. Level 1/2
    # entries (uncal, rate, cal) are filed separately and don't carry x1d.
    obs = Observations.query_criteria(
        objectname=JWST_TARGET,
        radius="0.02 deg",
        obs_collection="JWST",
        calib_level=3,
    )
    print(f"[JWST] L3 JWST observations near {JWST_TARGET}: {len(obs)} rows")
    if len(obs) == 0:
        print("[JWST] no L3 observations in cone", file=sys.stderr)
        return False

    print(
        f"[JWST] dataproduct_type distribution: "
        f"{ {str(t): int((obs['dataproduct_type'] == t).sum()) for t in set(obs['dataproduct_type'])} }"
    )

    # Drop imaging — even at L3, MIRI imaging mosaics yield no x1d.
    obs = obs[obs["dataproduct_type"] != "image"]
    print(f"[JWST] non-image L3 observations: {len(obs)}")
    if len(obs) == 0:
        return False

    obs = obs[:JWST_OBS_CAP]
    products = Observations.get_product_list(obs)
    print(f"[JWST] products in capped slice: {len(products)}")

    # MAST defaults filter_products to MRP-only, which strips per-integration x1d
    # outputs from JWST timeseries listings. Disable to see everything.
    filtered = Observations.filter_products(
        products,
        productType="SCIENCE",
        extension=["x1dints.fits", "x1d.fits"],
        mrp_only=False,
    )
    print(f"[JWST] x1d/x1dints science products: {len(filtered)}")
    if len(filtered) == 0:
        suffixes = {}
        for p in products:
            fn = str(p.get("productFilename", ""))
            key = fn.rsplit("_", 1)[-1] if "_" in fn else fn
            suffixes[key] = suffixes.get(key, 0) + 1
        top = sorted(suffixes.items(), key=lambda kv: -kv[1])[:8]
        print(f"[JWST] product suffix histogram (top 8): {top}", file=sys.stderr)
        return False

    filtered = filtered[:JWST_FILE_CAP]
    manifest = Observations.download_products(filtered, download_dir=str(JWST_OUT))
    print(f"[JWST] downloaded {len(manifest)} files to {JWST_OUT}")
    return True


def push_to_hub() -> None:
    from huggingface_hub import HfApi, create_repo

    token = os.environ["HF_TOKEN"]
    create_repo(REPO_ID, repo_type="dataset", token=token, exist_ok=True)

    api = HfApi()
    api.upload_folder(
        folder_path=str(WORK),
        repo_id=REPO_ID,
        repo_type="dataset",
        token=token,
        commit_message=f"batch: psp {PSP_TRANGE[0]} + jwst {JWST_TARGET}",
    )
    print(f"[HF] uploaded {WORK} to https://huggingface.co/datasets/{REPO_ID}")


def main() -> int:
    if "HF_TOKEN" not in os.environ:
        print("ERROR: HF_TOKEN env var not set", file=sys.stderr)
        return 1

    PSP_OUT.mkdir(parents=True, exist_ok=True)
    JWST_OUT.mkdir(parents=True, exist_ok=True)

    psp_ok = False
    jwst_ok = False
    try:
        psp_ok = pull_psp_fields()
    except Exception as e:
        print(f"[PSP] failed: {e}", file=sys.stderr)
    try:
        jwst_ok = pull_jwst_trappist1()
    except Exception as e:
        print(f"[JWST] failed: {e}", file=sys.stderr)

    if not (psp_ok or jwst_ok):
        print("ERROR: both PSP and JWST failed; refusing empty push", file=sys.stderr)
        return 1

    push_to_hub()
    return 0


if __name__ == "__main__":
    sys.exit(main())
