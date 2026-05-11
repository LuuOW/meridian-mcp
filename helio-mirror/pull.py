#!/usr/bin/env python3
"""
Stage 1 — helio-mirror multi-source pull.

Pulls, for one perihelion window:
  - PSP FIELDS L2 + SWEAP/SPC L3 via pyspedas
  - JWST solar-system body observations (Mars / Jupiter / Saturn by default)
    via astroquery MAST, calib_level=3
  - JPL Horizons heliocentric vectors for PSP + each target body + Earth

Outputs are pushed to the public HF dataset `luuow/meridian-helio-mirror`
(auto-created on first push). Set HF_TOKEN env var; choose perihelion via
HELIO_PERIHELION (default E20).
"""
from __future__ import annotations

import os
import sys
import traceback
from pathlib import Path

import pandas as pd
import pyspedas
import pytplot
import numpy as np
from astroquery.jplhorizons import Horizons
from astroquery.mast import Observations
from huggingface_hub import HfApi, create_repo

from targets import BODIES, PSP_NAIF, PERIHELIA, JWST_BODIES_DEFAULT, EPHEMERIS_BODIES_DEFAULT

REPO_ID = "luuow/meridian-helio-mirror"
PERIHELION = os.environ.get("HELIO_PERIHELION", "E20")
JWST_CAP_PER_BODY = int(os.environ.get("JWST_CAP_PER_BODY", "2"))
JWST_FILE_CAP_PER_BODY = int(os.environ.get("JWST_FILE_CAP_PER_BODY", "3"))


def fetch_psp_fields(t_start: str, t_stop: str) -> pd.DataFrame:
    pyspedas.psp.fields(
        trange=[t_start, t_stop],
        datatype="mag_rtn_4_per_cycle",
        level="l2",
        time_clip=True,
    )
    data = pytplot.get_data("psp_fld_l2_mag_RTN_4_Sa_per_Cyc")
    pytplot.del_data("*")
    if data is None or len(data.times) == 0:
        return pd.DataFrame()
    return pd.DataFrame({
        "time": pd.to_datetime(data.times, unit="s"),
        "B_R": data.y[:, 0],
        "B_T": data.y[:, 1],
        "B_N": data.y[:, 2],
    })


def fetch_psp_sweap_spi(t_start: str, t_stop: str) -> pd.DataFrame:
    """SWEAP/SPAN-I L3 ion moments. SPC L3i is gappy post-E18 due to instrument
    issues; SPAN-I has cleaner coverage at perihelion."""
    pyspedas.psp.spi(
        trange=[t_start, t_stop],
        datatype="sf00_l3_mom",
        level="l3",
        time_clip=True,
    )
    vel = pytplot.get_data("psp_swp_spi_sf00_L3_VEL_RTN_SUN")
    dens = pytplot.get_data("psp_swp_spi_sf00_L3_DENS")
    temp = pytplot.get_data("psp_swp_spi_sf00_L3_TEMP")
    pytplot.del_data("*")
    if vel is None or dens is None:
        return pd.DataFrame()
    df = pd.DataFrame({
        "time": pd.to_datetime(vel.times, unit="s"),
        "v_R_km_s": vel.y[:, 0],
        "v_T_km_s": vel.y[:, 1],
        "v_N_km_s": vel.y[:, 2],
        "n_p_cm3": dens.y,
    })
    if temp is not None:
        df["T_eV"] = temp.y
    return df


def fetch_ephemeris(naif_id: str, t_start: str, t_stop: str, step: str = "1h") -> pd.DataFrame:
    obj = Horizons(
        id=naif_id,
        location="@sun",
        epochs={"start": t_start, "stop": t_stop, "step": step},
    )
    vec = obj.vectors().to_pandas()
    return pd.DataFrame({
        "time_jd": vec["datetime_jd"].astype(float),
        "x_au":    vec["x"].astype(float),
        "y_au":    vec["y"].astype(float),
        "z_au":    vec["z"].astype(float),
        "r_au":    vec["range"].astype(float),
    })


def search_jwst(target_name: str, cap: int,
                t_start: str | None = None, t_stop: str | None = None,
                window_days: int = 365):
    """Find JWST L3 observations of target_name. If t_start/t_stop given,
    require the observation midpoint within ±window_days of either endpoint
    (so the JWST data is temporally close to the PSP perihelion of interest).

    MAST stores t_min / t_max as MJD floats. Falls back to a no-time-filter
    query if the windowed search returns nothing — better partial data than
    a silent empty pull."""
    criteria = dict(obs_collection="JWST", target_name=target_name, calib_level=3)
    if t_start and t_stop:
        from astropy.time import Time
        mjd_lo = Time(t_start).mjd - window_days
        mjd_hi = Time(t_stop).mjd + window_days
        criteria["t_min"] = [mjd_lo, mjd_hi]
        obs = Observations.query_criteria(**criteria)
        if len(obs) > 0:
            return obs[: min(cap, len(obs))]
        print(f"[jwst] no obs of {target_name} within ±{window_days} d of "
              f"{t_start}–{t_stop}; falling back to nearest in time")
        criteria.pop("t_min", None)
    obs = Observations.query_criteria(**criteria)
    if len(obs) == 0:
        return obs
    if t_start and "t_min" not in obs.colnames:
        return obs[: min(cap, len(obs))]
    from astropy.time import Time
    target_mjd = (Time(t_start).mjd + Time(t_stop).mjd) / 2.0 if t_start and t_stop else None
    if target_mjd is not None and "t_min" in obs.colnames:
        obs.sort([("t_min", lambda x: abs(x - target_mjd))]) if False else None
        idx = np.argsort(np.abs(np.asarray(obs["t_min"]) - target_mjd))
        obs = obs[idx]
    return obs[: min(cap, len(obs))]


def select_jwst_products(obs):
    """Pick FITS science products before capping. Catalog/auxiliary files (cat.ecsv,
    asn.json) match the SCIENCE+calib_level=3 mask but aren't actually the science
    image/spectrum — preferring i2d/s3d/x1d FITS lands real reflectance data."""
    products = Observations.get_product_list(obs)
    if len(products) == 0:
        return products
    science = products[(products["productType"] == "SCIENCE") &
                       (products["calib_level"] == 3)]
    if len(science) == 0:
        return science
    fits_mask = [str(fn).endswith(".fits") for fn in science["productFilename"]]
    fits_only = science[fits_mask]
    if len(fits_only) == 0:
        fits_only = science
    preferred_suffixes = ("_i2d.fits", "_s3d.fits", "_x1d.fits", "_x1dints.fits")
    pref_mask = [any(str(fn).endswith(s) for s in preferred_suffixes)
                 for fn in fits_only["productFilename"]]
    preferred = fits_only[pref_mask] if any(pref_mask) else fits_only
    if len(preferred) > JWST_FILE_CAP_PER_BODY:
        preferred = preferred[:JWST_FILE_CAP_PER_BODY]
    return preferred


def push(api: HfApi, local: Path, repo_path: str, message: str) -> None:
    api.upload_file(
        path_or_fileobj=str(local),
        path_in_repo=repo_path,
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message=message,
    )


def pull_psp(api: HfApi, t_start: str, t_stop: str, out: Path) -> bool:
    ok = False
    days = pd.date_range(t_start, t_stop, freq="D")
    for day in days:
        try:
            day_str = day.strftime("%Y-%m-%d")
            day_next = (day + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
            print(f"[psp/fields] {day_str}")
            df = fetch_psp_fields(day_str, day_next)
            if df.empty:
                print(f"[psp/fields] no data {day_str}")
                continue
            path = out / "psp" / f"fields_{day_str}.parquet"
            path.parent.mkdir(parents=True, exist_ok=True)
            df.to_parquet(path, compression="snappy")
            push(api, path, f"psp/fields_{day_str}.parquet", f"stage-1: PSP FIELDS {day_str}")
            ok = True
        except Exception as e:
            print(f"[psp/fields] {day_str} failed: {e}", file=sys.stderr)
            traceback.print_exc()
    try:
        print(f"[psp/sweap-spi] {t_start} → {t_stop}")
        df = fetch_psp_sweap_spi(t_start, t_stop)
        if not df.empty:
            path = out / "psp" / f"sweap_spi_{PERIHELION}.parquet"
            path.parent.mkdir(parents=True, exist_ok=True)
            df.to_parquet(path, compression="snappy")
            push(api, path, f"psp/sweap_spi_{PERIHELION}.parquet",
                 f"stage-1: PSP SWEAP/SPAN-I {PERIHELION}")
            ok = True
        else:
            print("[psp/sweap-spi] empty frame (data gap at this perihelion)")
    except Exception as e:
        print(f"[psp/sweap-spi] failed: {e}", file=sys.stderr)
        traceback.print_exc()
    return ok


def pull_jwst(api: HfApi, out: Path, bodies: tuple[str, ...],
               t_start: str, t_stop: str) -> bool:
    ok = False
    for body_name in bodies:
        body = BODIES.get(body_name)
        if body is None or not body.jwst_names:
            continue
        for tgt in body.jwst_names:
            try:
                print(f"[jwst] searching {tgt} near {t_start}–{t_stop}")
                obs = search_jwst(tgt, cap=JWST_CAP_PER_BODY,
                                   t_start=t_start, t_stop=t_stop)
                if len(obs) == 0:
                    print(f"[jwst] no obs for {tgt}")
                    continue
                products = select_jwst_products(obs)
                if len(products) == 0:
                    print(f"[jwst] no calib_level=3 SCIENCE products for {tgt}")
                    continue
                dest = out / "jwst" / body.name
                dest.mkdir(parents=True, exist_ok=True)
                print(f"[jwst] downloading {len(products)} products for {body.name}")
                manifest = Observations.download_products(
                    products, download_dir=str(dest), curl_flag=False)
                for row in manifest:
                    if "Local Path" not in manifest.colnames:
                        continue
                    local = Path(row["Local Path"])
                    if not local.exists():
                        continue
                    rel = local.relative_to(out)
                    push(api, local, str(rel),
                         f"stage-1: JWST {body.name} {local.name}")
                    ok = True
            except Exception as e:
                print(f"[jwst] {body.name}/{tgt} failed: {e}", file=sys.stderr)
                traceback.print_exc()
    return ok


def pull_ephemeris(api: HfApi, t_start: str, t_stop: str, out: Path,
                    bodies: tuple[str, ...]) -> bool:
    ok = False
    try:
        print(f"[eph/PSP] {t_start} → {t_stop}")
        df = fetch_ephemeris(PSP_NAIF, t_start, t_stop)
        path = out / "ephemeris" / f"PSP_{PERIHELION}.parquet"
        path.parent.mkdir(parents=True, exist_ok=True)
        df.to_parquet(path)
        push(api, path, f"ephemeris/PSP_{PERIHELION}.parquet",
             f"stage-1: ephemeris PSP {PERIHELION}")
        ok = True
    except Exception as e:
        print(f"[eph/PSP] failed: {e}", file=sys.stderr)
        traceback.print_exc()

    for body_name in bodies:
        body = BODIES.get(body_name)
        if body is None:
            continue
        try:
            print(f"[eph/{body.name}] {t_start} → {t_stop}")
            df = fetch_ephemeris(body.naif_id, t_start, t_stop)
            path = out / "ephemeris" / f"{body.name}_{PERIHELION}.parquet"
            df.to_parquet(path)
            push(api, path, f"ephemeris/{body.name}_{PERIHELION}.parquet",
                 f"stage-1: ephemeris {body.name} {PERIHELION}")
            ok = True
        except Exception as e:
            print(f"[eph/{body.name}] failed: {e}", file=sys.stderr)
            traceback.print_exc()
    return ok


def main() -> int:
    if "HF_TOKEN" not in os.environ:
        print("ERROR: HF_TOKEN not set", file=sys.stderr)
        return 1
    token = os.environ["HF_TOKEN"]
    api = HfApi(token=token)

    if PERIHELION not in PERIHELIA:
        print(f"ERROR: unknown perihelion {PERIHELION}; one of {list(PERIHELIA)}",
              file=sys.stderr)
        return 1
    t_start, t_stop = PERIHELIA[PERIHELION]
    print(f"[helio-mirror stage-1] perihelion={PERIHELION} window={t_start} → {t_stop}")

    try:
        create_repo(repo_id=REPO_ID, repo_type="dataset", token=token,
                     exist_ok=True, private=False)
        print(f"[helio-mirror] HF dataset ready: https://huggingface.co/datasets/{REPO_ID}")
    except Exception as e:
        print(f"[helio-mirror] create_repo: {e}")

    out = Path("helio_cache")
    out.mkdir(parents=True, exist_ok=True)

    psp_ok = pull_psp(api, t_start, t_stop, out)
    eph_ok = pull_ephemeris(api, t_start, t_stop, out, EPHEMERIS_BODIES_DEFAULT)
    jwst_ok = pull_jwst(api, out, JWST_BODIES_DEFAULT, t_start, t_stop)

    print("\n[helio-mirror] stage-1 done.")
    print(f"  PSP:       {'OK' if psp_ok else 'FAIL'}")
    print(f"  Ephemeris: {'OK' if eph_ok else 'FAIL'}")
    print(f"  JWST:      {'OK' if jwst_ok else 'FAIL'}")
    if not (psp_ok or eph_ok or jwst_ok):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
