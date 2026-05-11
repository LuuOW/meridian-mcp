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

import json
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

from targets import BODIES, PSP_NAIF, PERIHELIA, JWST_BODIES_DEFAULT, EPHEMERIS_BODIES_DEFAULT, SPACECRAFT, SPACECRAFT_DEFAULT
from probes import LOADER_MAP

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


def fetch_psp_isois_epihi(t_start: str, t_stop: str) -> pd.DataFrame:
    """ISOIS/EPI-Hi L2 integrated proton flux.

    We don't need the full energy spectrum here — just one or two integrated
    flux channels are enough to flag SEP onsets. EPI-Hi exposes a `let1`
    (Low Energy Telescope) high-energy proton variable; pulling that as a
    time series is the minimal SEP detector.
    """
    pyspedas.psp.epihi(
        trange=[t_start, t_stop],
        datatype="let1_rates",
        level="l2",
        time_clip=True,
    )
    candidates = (
        "psp_isois_epihi_let1_protons_he_rate",
        "psp_isois_epihi_let1_h_flux",
        "psp_isois_let1_h_int_rate",
    )
    chosen = None
    for name in candidates:
        d = pytplot.get_data(name)
        if d is not None:
            chosen = (name, d)
            break
    pytplot.del_data("*")
    if chosen is None:
        return pd.DataFrame()
    var_name, data = chosen
    y = data.y
    if y.ndim > 1:
        y_scalar = np.nansum(y, axis=1) if y.shape[1] > 1 else y[:, 0]
    else:
        y_scalar = y
    return pd.DataFrame({
        "time": pd.to_datetime(data.times, unit="s"),
        "source_variable": var_name,
        "proton_rate": y_scalar.astype(float),
    })


def fetch_psp_wispr(t_start: str, t_stop: str) -> pd.DataFrame:
    """WISPR L3 inner/outer detector brightness time series.

    pyspedas does not (as of this writing) expose a wispr loader — it ships
    fields/spc/spe/spi/epihi/epilo/rfs only. We short-circuit here so the
    workflow doesn't spam an AttributeError every pull; a direct PSP SOC
    fetcher is a v0.4 item. Stage 3b (detect_wispr) handles the empty input
    gracefully and emits no events.
    """
    if not hasattr(pyspedas.psp, "wispr"):
        print("[psp/wispr] pyspedas has no wispr loader; stage 3b is gated until "
              "we ship a direct PSP SOC fetcher", file=sys.stderr)
        return pd.DataFrame()
    pyspedas.psp.wispr(
        trange=[t_start, t_stop],
        datatype="science",
        level="l3",
        time_clip=True,
    )
    rows: list[dict] = []
    for det_var, det_name in (
        ("psp_wispr_inner_image", "inner"),
        ("psp_wispr_outer_image", "outer"),
    ):
        data = pytplot.get_data(det_var)
        if data is None:
            continue
        times = pd.to_datetime(data.times, unit="s")
        cube = data.y
        if cube.ndim != 3:
            continue
        for i in range(cube.shape[0]):
            frame = cube[i]
            valid = np.isfinite(frame)
            if not valid.any():
                continue
            rows.append({
                "time": times[i],
                "detector": det_name,
                "n_pixels_valid": int(valid.sum()),
                "brightness_mean": float(np.nanmean(frame)),
                "brightness_sum": float(np.nansum(frame)),
                "brightness_p99": float(np.nanpercentile(frame, 99)),
                "brightness_max": float(np.nanmax(frame)),
            })
    pytplot.del_data("*")
    return pd.DataFrame(rows)


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
    from hf_push import push as _push
    _push(api, REPO_ID, local, repo_path, message)


def push_subdir(api: HfApi, local_dir: Path, repo_subdir: str, message: str,
                 patterns: list[str] | None = None) -> None:
    from hf_push import push_folder
    push_folder(api, REPO_ID, local_dir, repo_subdir, message, allow_patterns=patterns)


def pull_psp(api: HfApi, t_start: str, t_stop: str, out: Path) -> bool:
    """Pull all PSP instruments into out/psp/ locally first, then one folder
    commit. HF rate-limits at 128 commits/hour; folder commits batch many
    files into one."""
    ok = False
    psp_dir = out / "psp"
    psp_dir.mkdir(parents=True, exist_ok=True)
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
            path = psp_dir / f"fields_{day_str}.parquet"
            df.to_parquet(path, compression="snappy")
            ok = True
        except Exception as e:
            print(f"[psp/fields] {day_str} failed: {e}", file=sys.stderr)
            traceback.print_exc()
    try:
        print(f"[psp/sweap-spi] {t_start} → {t_stop}")
        df = fetch_psp_sweap_spi(t_start, t_stop)
        if not df.empty:
            df.to_parquet(psp_dir / f"sweap_spi_{PERIHELION}.parquet", compression="snappy")
            ok = True
        else:
            print("[psp/sweap-spi] empty frame (data gap at this perihelion)")
    except Exception as e:
        print(f"[psp/sweap-spi] failed: {e}", file=sys.stderr)
        traceback.print_exc()
    try:
        print(f"[psp/wispr] {t_start} → {t_stop}")
        df = fetch_psp_wispr(t_start, t_stop)
        if not df.empty:
            df.to_parquet(psp_dir / f"wispr_brightness_{PERIHELION}.parquet", compression="snappy")
            ok = True
        else:
            print("[psp/wispr] empty frame (data gap at this perihelion)")
    except Exception as e:
        print(f"[psp/wispr] failed: {e}", file=sys.stderr)
        traceback.print_exc()
    try:
        print(f"[psp/isois-epihi] {t_start} → {t_stop}")
        df = fetch_psp_isois_epihi(t_start, t_stop)
        if not df.empty:
            df.to_parquet(psp_dir / f"isois_epihi_{PERIHELION}.parquet", compression="snappy")
            ok = True
        else:
            print("[psp/isois-epihi] empty frame")
    except Exception as e:
        print(f"[psp/isois-epihi] failed: {e}", file=sys.stderr)
        traceback.print_exc()
    if ok:
        push_subdir(api, psp_dir, "psp",
                    f"stage-1: PSP raw bundle {PERIHELION}",
                    patterns=["*.parquet"])
        print(f"[psp] folder-uploaded {len(list(psp_dir.glob('*.parquet')))} parquets")
    return ok


def pull_jwst(api: HfApi, out: Path, bodies: tuple[str, ...],
               t_start: str, t_stop: str) -> bool:
    """Download JWST FITS for each candidate body into out/jwst/ locally,
    then one folder commit at the end (HF 128 commits/hour cap)."""
    ok = False
    jwst_root = out / "jwst"
    jwst_root.mkdir(parents=True, exist_ok=True)
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
                dest = jwst_root / body.name
                dest.mkdir(parents=True, exist_ok=True)
                print(f"[jwst] downloading {len(products)} products for {body.name}")
                Observations.download_products(
                    products, download_dir=str(dest), curl_flag=False)
                ok = True
            except Exception as e:
                print(f"[jwst] {body.name}/{tgt} failed: {e}", file=sys.stderr)
                traceback.print_exc()
    if ok:
        fits_count = sum(1 for _ in jwst_root.rglob("*.fits"))
        push_subdir(api, jwst_root, "jwst",
                    f"stage-1: JWST solar-system bundle {PERIHELION} "
                    f"({fits_count} FITS)",
                    patterns=["*.fits", "*.ecsv", "*.json"])
        print(f"[jwst] folder-uploaded {fits_count} FITS")
    return ok


def pull_probes(api: HfApi, t_start: str, t_stop: str, out: Path,
                 spacecraft: tuple[str, ...]) -> bool:
    """HSO mode — pull B-field RTN time series from every spacecraft in the
    list. PSP gets its richer specialised loader via pull_psp(); here we just
    do uniform MAG-only ingestion across the heliophysics fleet for cross-
    spacecraft event detection in stage-3+.

    Also writes status/probes_status_{P}.json so the dashboard can show which
    probes landed data and which failed, without forcing the user to dig in
    GitHub Actions logs.
    """
    ok = False
    probes_dir = out / "probes"
    probes_dir.mkdir(parents=True, exist_ok=True)
    status = {
        "perihelion": PERIHELION,
        "window": [t_start, t_stop],
        "loaded": [],          # {sc, samples}
        "empty": [],           # spacecraft with empty CDAWeb response
        "failed": {},          # {sc: error message}
        "skipped": [],         # PSP (specialised loader) or unknown
    }
    for sc in spacecraft:
        if sc == "PSP":
            status["skipped"].append(sc)
            continue  # PSP handled by pull_psp with its specialised products
        info = SPACECRAFT.get(sc)
        if info is None:
            status["skipped"].append(sc)
            continue
        loader = LOADER_MAP.get(info["loader"])
        if loader is None:
            status["skipped"].append(sc)
            continue
        try:
            print(f"[probes/{sc}] {t_start} → {t_stop}")
            df = loader(t_start, t_stop)
            if df.empty:
                print(f"[probes/{sc}] empty (no data on CDAWeb for this window)")
                status["empty"].append(sc)
                continue
            df["spacecraft"] = sc
            safe = sc.replace("/", "_").replace(" ", "_")
            df.to_parquet(probes_dir / f"{safe}_mag_{PERIHELION}.parquet", compression="snappy")
            ok = True
            status["loaded"].append({"sc": sc, "samples": int(len(df))})
            print(f"[probes/{sc}] {len(df)} samples")
        except Exception as e:
            print(f"[probes/{sc}] failed: {e}", file=sys.stderr)
            status["failed"][sc] = str(e)[:200]
            traceback.print_exc()

    # Push status JSON regardless of outcome so the dashboard can show "all
    # failed" as a distinct state, not "no data".
    status_dir = out / "status"
    status_dir.mkdir(parents=True, exist_ok=True)
    status_path = status_dir / f"probes_status_{PERIHELION}.json"
    status_path.write_text(json.dumps(status, indent=2))
    try:
        push_subdir(api, status_dir, "status",
                     f"stage-1: probes_status {PERIHELION} "
                     f"({len(status['loaded'])}/{len(spacecraft)-1} loaded)",
                     patterns=[f"probes_status_{PERIHELION}.json"])
        print(f"[probes] pushed status/probes_status_{PERIHELION}.json: "
              f"{len(status['loaded'])} loaded, {len(status['empty'])} empty, "
              f"{len(status['failed'])} failed")
    except Exception as e:
        print(f"[probes] status push failed (continuing): {e}", file=sys.stderr)

    if ok:
        push_subdir(api, probes_dir, "probes",
                     f"stage-1: HSO probe magnetometer bundle {PERIHELION}",
                     patterns=[f"*_mag_{PERIHELION}.parquet"])
        print(f"[probes] folder-uploaded {len(list(probes_dir.glob(f'*_mag_{PERIHELION}.parquet')))} probes")
    return ok


def pull_ephemeris(api: HfApi, t_start: str, t_stop: str, out: Path,
                    bodies: tuple[str, ...]) -> bool:
    ok = False
    eph_dir = out / "ephemeris"
    eph_dir.mkdir(parents=True, exist_ok=True)
    try:
        print(f"[eph/PSP] {t_start} → {t_stop}")
        df = fetch_ephemeris(PSP_NAIF, t_start, t_stop)
        df.to_parquet(eph_dir / f"PSP_{PERIHELION}.parquet")
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
            df.to_parquet(eph_dir / f"{body.name}_{PERIHELION}.parquet")
            ok = True
        except Exception as e:
            print(f"[eph/{body.name}] failed: {e}", file=sys.stderr)
            traceback.print_exc()
    for sc, info in SPACECRAFT.items():
        if sc == "PSP":
            continue
        try:
            print(f"[eph/{sc}] {t_start} → {t_stop}")
            df = fetch_ephemeris(info["naif"], t_start, t_stop)
            safe = sc.replace("/", "_").replace(" ", "_")
            df.to_parquet(eph_dir / f"{safe}_{PERIHELION}.parquet")
            ok = True
        except Exception as e:
            print(f"[eph/{sc}] failed: {e}", file=sys.stderr)
            traceback.print_exc()
    if ok:
        push_subdir(api, eph_dir, "ephemeris",
                    f"stage-1: ephemeris bundle (bodies + HSO probes) {PERIHELION}",
                    patterns=[f"*_{PERIHELION}.parquet"])
        print(f"[eph] folder-uploaded {len(list(eph_dir.glob(f'*_{PERIHELION}.parquet')))} parquets")
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
    probes_ok = pull_probes(api, t_start, t_stop, out, SPACECRAFT_DEFAULT)
    eph_ok = pull_ephemeris(api, t_start, t_stop, out, EPHEMERIS_BODIES_DEFAULT)
    jwst_ok = pull_jwst(api, out, JWST_BODIES_DEFAULT, t_start, t_stop)

    print("\n[helio-mirror] stage-1 done.")
    print(f"  PSP:       {'OK' if psp_ok else 'FAIL'}")
    print(f"  HSO probes:{'OK' if probes_ok else 'FAIL'}")
    print(f"  Ephemeris: {'OK' if eph_ok else 'FAIL'}")
    print(f"  JWST:      {'OK' if jwst_ok else 'FAIL'}")
    if not (psp_ok or probes_ok or eph_ok or jwst_ok):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
