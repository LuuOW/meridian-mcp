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

PSP_TRANGE = ["2024-09-30", "2024-10-01"]
JWST_TARGET = "TRAPPIST-1"
JWST_OBS_CAP = 3
JWST_FILE_CAP = 5

REPO_ID = "LuuOW/meridian-stellar-cache"


def pull_psp_fields() -> bool:
    import pyspedas
    from pytplot import get_data
    import pandas as pd

    pyspedas.psp.fields(
        trange=PSP_TRANGE,
        datatype="mag_rtn_4_per_cycle",
        level="l2",
        time_clip=True,
        notplot=False,
    )

    var = "psp_fld_l2_mag_RTN_4_Sa_per_Cyc"
    data = get_data(var)
    if data is None:
        print(f"[PSP] variable {var!r} returned no data", file=sys.stderr)
        return False

    df = pd.DataFrame(
        {
            "time": pd.to_datetime(data.times, unit="s"),
            "B_R": data.y[:, 0],
            "B_T": data.y[:, 1],
            "B_N": data.y[:, 2],
        }
    )
    out = PSP_OUT / f"fields_mag_rtn_{PSP_TRANGE[0]}.parquet"
    df.to_parquet(out, compression="snappy")
    print(f"[PSP] wrote {out} ({len(df)} rows)")
    return True


def pull_jwst_trappist1() -> bool:
    from astroquery.mast import Observations

    obs = Observations.query_criteria(
        target_name=JWST_TARGET,
        obs_collection="JWST",
        dataproduct_type="spectrum",
    )
    if len(obs) == 0:
        print(f"[JWST] no observations for {JWST_TARGET}", file=sys.stderr)
        return False

    obs = obs[:JWST_OBS_CAP]
    products = Observations.get_product_list(obs)
    filtered = Observations.filter_products(
        products,
        productType="SCIENCE",
        extension="x1d.fits",
    )
    if len(filtered) == 0:
        print("[JWST] no x1d products in slice", file=sys.stderr)
        return False

    filtered = filtered[:JWST_FILE_CAP]
    manifest = Observations.download_products(
        filtered,
        download_dir=str(JWST_OUT),
    )
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
