#!/usr/bin/env python3
"""
Stage 2 — heliographic registration.

For every measurement in the HF dataset, derive its position in the
heliocentric ecliptic frame at the time of observation:
  - PSP measurements get tagged with PSP's (helio_lon, helio_lat, r, t).
  - JWST observations get tagged with the *target body's* (helio_lon, helio_lat,
    r, t) at the FITS header timestamp.
  - Ephemeris rows pass through with derived heliographic angles.

This layer is what later stages join on. Without it the cross-correlation
between "PSP saw a CME going in direction φ" and "JWST observed a body at
heliographic longitude φ_B" has nothing to match on.

Outputs to `luuow/meridian-helio-mirror`:
  coords/ephemeris_long.parquet  — all (body, t) ephemeris rows + derived angles
  coords/psp_registered.parquet  — every PSP B-field sample with PSP's heliographic position
  coords/jwst_registered.parquet — every JWST FITS with target body's heliographic position
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

from targets import BODIES, PERIHELIA, SPACECRAFT

REPO_ID = "luuow/meridian-helio-mirror"
PERIHELION = os.environ.get("HELIO_PERIHELION", "E20")

OMEGA_SUN_DEG_PER_DAY = 14.713
J2000_TIMESTAMP = pd.Timestamp("2000-01-01T12:00:00")


def heliocentric_lon_deg(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    return np.degrees(np.arctan2(y, x))


def heliocentric_lat_deg(x: np.ndarray, y: np.ndarray, z: np.ndarray) -> np.ndarray:
    return np.degrees(np.arctan2(z, np.sqrt(x ** 2 + y ** 2)))


def carrington_lon_deg(phi_inertial_deg: np.ndarray, t_seconds_since_j2000: np.ndarray) -> np.ndarray:
    """Approximate Carrington longitude from inertial heliocentric longitude.

    The reference epoch is J2000; the absolute Carrington rotation number is
    immaterial here — all we need is a consistent corotating-with-sun frame so
    that ‘same Carrington longitude across PSP and body’ is computable.
    """
    delta_deg = OMEGA_SUN_DEG_PER_DAY * (t_seconds_since_j2000 / 86400.0)
    return (phi_inertial_deg - delta_deg) % 360.0


def push(api: HfApi, local: Path, repo_path: str, message: str) -> None:
    from hf_push import push as _push
    _push(api, REPO_ID, local, repo_path, message)


def load_ephemeris_long(token: str) -> pd.DataFrame:
    files = list_repo_files(REPO_ID, repo_type="dataset", token=token)
    suffix = f"_{PERIHELION}.parquet"
    eph_files = [f for f in files if f.startswith("ephemeris/") and f.endswith(suffix)]
    if not eph_files:
        return pd.DataFrame()

    rows = []
    sc_safe_lookup = {sc.replace("/", "_").replace(" ", "_"): sc for sc in SPACECRAFT}
    for f in eph_files:
        path = hf_hub_download(repo_id=REPO_ID, repo_type="dataset",
                               filename=f, token=token)
        body = Path(f).name.replace(suffix, "")
        body = sc_safe_lookup.get(body, body)
        df = pd.read_parquet(path)
        df["timestamp"] = pd.to_datetime(df["time_jd"], unit="D", origin="julian")
        df["body"] = body
        x, y, z = df["x_au"].to_numpy(), df["y_au"].to_numpy(), df["z_au"].to_numpy()
        df["helio_lon_deg"] = heliocentric_lon_deg(x, y)
        df["helio_lat_deg"] = heliocentric_lat_deg(x, y, z)
        t_secs = (df["timestamp"] - J2000_TIMESTAMP).dt.total_seconds().to_numpy()
        df["carrington_lon_deg"] = carrington_lon_deg(df["helio_lon_deg"].to_numpy(), t_secs)
        rows.append(df[["timestamp", "body", "x_au", "y_au", "z_au", "r_au",
                        "helio_lon_deg", "helio_lat_deg", "carrington_lon_deg"]])
    out = pd.concat(rows, ignore_index=True).sort_values(["body", "timestamp"])
    print(f"[stage-2] ephemeris_long: {len(out)} rows across "
          f"{out['body'].nunique()} bodies")
    return out


def register_psp(token: str, eph_psp: pd.DataFrame) -> pd.DataFrame:
    files = list_repo_files(REPO_ID, repo_type="dataset", token=token)
    psp_files = [f for f in files if f.startswith("psp/fields_") and f.endswith(".parquet")]
    if not psp_files:
        return pd.DataFrame()

    chunks = []
    for f in psp_files:
        path = hf_hub_download(repo_id=REPO_ID, repo_type="dataset",
                               filename=f, token=token)
        df = pd.read_parquet(path)
        df["source_file"] = f
        chunks.append(df)
    psp = pd.concat(chunks, ignore_index=True)
    psp["time"] = pd.to_datetime(psp["time"]).dt.tz_localize(None)
    psp = psp.sort_values("time")

    eph_psp_sorted = eph_psp.sort_values("timestamp")
    joined = pd.merge_asof(
        psp, eph_psp_sorted,
        left_on="time", right_on="timestamp",
        direction="nearest", tolerance=pd.Timedelta("1h"),
    )
    out_cols = ["time", "source_file", "B_R", "B_T", "B_N",
                "x_au", "y_au", "z_au", "r_au",
                "helio_lon_deg", "helio_lat_deg", "carrington_lon_deg"]
    out = joined[out_cols].rename(columns={"time": "timestamp"})
    print(f"[stage-2] psp_registered: {len(out)} samples, "
          f"r_AU range {out['r_au'].min():.3f}–{out['r_au'].max():.3f}")
    return out


def _read_fits_meta(local_path: Path) -> dict | None:
    try:
        hdr = fits.getheader(local_path)
    except Exception as e:
        print(f"[stage-2/jwst] failed to read {local_path.name}: {e}",
              file=sys.stderr)
        return None
    date_obs = hdr.get("DATE-OBS") or hdr.get("DATE-BEG") or hdr.get("DATE")
    targname = hdr.get("TARGNAME") or hdr.get("TARGPROP") or ""
    inst = hdr.get("INSTRUME") or ""
    filtr = hdr.get("FILTER") or hdr.get("PUPIL") or ""
    exptime = hdr.get("EFFEXPTM") or hdr.get("EXPTIME") or 0.0
    if not date_obs:
        return None
    return {
        "timestamp": pd.Timestamp(date_obs),
        "targname_raw": targname,
        "instrument": inst,
        "filter": filtr,
        "exposure_sec": float(exptime),
    }


def _resolve_body(targname_raw: str, source_file: str) -> str | None:
    """Map FITS TARGNAME or directory-derived label to one of our BODIES."""
    up = (targname_raw or "").upper().strip()
    for body_name, body in BODIES.items():
        if up in body.jwst_names or up == body_name.upper():
            return body_name
    parts = Path(source_file).parts
    for p in parts:
        for body_name in BODIES:
            if p == body_name:
                return body_name
    return None


def register_probes(token: str, eph: pd.DataFrame) -> pd.DataFrame:
    """Per HSO spacecraft (SolO / STEREO-A / Wind / ACE / DSCOVR / MAVEN),
    join its B-field samples to its own ephemeris position via merge_asof.
    Returns a long-form frame keyed by (spacecraft, timestamp)."""
    files = list_repo_files(REPO_ID, repo_type="dataset", token=token)
    suffix = f"_mag_{PERIHELION}.parquet"
    probe_files = [f for f in files if f.startswith("probes/") and f.endswith(suffix)]
    if not probe_files:
        return pd.DataFrame()

    chunks: list[pd.DataFrame] = []
    for f in probe_files:
        sc_safe = Path(f).name.replace(suffix, "")
        sc = sc_safe.replace("_", "-") if sc_safe not in SPACECRAFT else sc_safe
        if sc not in SPACECRAFT:
            for k in SPACECRAFT:
                if k.replace("/", "_").replace(" ", "_") == sc_safe:
                    sc = k
                    break
        sc_eph = eph[eph["body"] == sc]
        if sc_eph.empty:
            print(f"[stage-2/probes] no ephemeris for {sc}; skipped {f}")
            continue
        try:
            path = hf_hub_download(repo_id=REPO_ID, repo_type="dataset",
                                    filename=f, token=token)
            df = pd.read_parquet(path)
        except Exception as e:
            print(f"[stage-2/probes] {f}: {e}", file=sys.stderr)
            continue
        df["time"] = pd.to_datetime(df["time"]).dt.tz_localize(None)
        df["spacecraft"] = sc
        df = df.sort_values("time")
        sc_eph_sorted = sc_eph.sort_values("timestamp")
        joined = pd.merge_asof(
            df, sc_eph_sorted,
            left_on="time", right_on="timestamp",
            direction="nearest", tolerance=pd.Timedelta("1h"),
        )
        chunks.append(joined[[
            "time", "spacecraft", "B_R", "B_T", "B_N",
            "x_au", "y_au", "z_au", "r_au",
            "helio_lon_deg", "helio_lat_deg", "carrington_lon_deg",
        ]].rename(columns={"time": "timestamp"}))
    if not chunks:
        return pd.DataFrame()
    out = pd.concat(chunks, ignore_index=True).sort_values(["spacecraft", "timestamp"])
    print(f"[stage-2] probes_registered: {len(out)} samples across "
          f"{out['spacecraft'].nunique()} spacecraft")
    print(out.groupby("spacecraft")["r_au"].agg(["count", "min", "max"]).to_string())
    return out


def register_jwst(token: str, eph: pd.DataFrame) -> pd.DataFrame:
    files = list_repo_files(REPO_ID, repo_type="dataset", token=token)
    jwst_files = [f for f in files if f.startswith("jwst/") and f.endswith(".fits")]
    if not jwst_files:
        return pd.DataFrame()

    rows = []
    for f in jwst_files:
        try:
            path = Path(hf_hub_download(repo_id=REPO_ID, repo_type="dataset",
                                        filename=f, token=token))
            meta = _read_fits_meta(path)
            if meta is None:
                continue
            body = _resolve_body(meta["targname_raw"], f)
            if body is None:
                print(f"[stage-2/jwst] unresolved body for {f} "
                      f"(TARGNAME={meta['targname_raw']!r})")
                continue
            body_eph = eph[eph["body"] == body]
            if body_eph.empty:
                print(f"[stage-2/jwst] no ephemeris for body={body}")
                continue
            ts = meta["timestamp"]
            idx = (body_eph["timestamp"] - ts).abs().idxmin()
            er = body_eph.loc[idx]
            rows.append({
                "source_file": f,
                "timestamp": ts,
                "body": body,
                "instrument": meta["instrument"],
                "filter": meta["filter"],
                "exposure_sec": meta["exposure_sec"],
                "x_au": er["x_au"], "y_au": er["y_au"], "z_au": er["z_au"],
                "r_au": er["r_au"],
                "helio_lon_deg": er["helio_lon_deg"],
                "helio_lat_deg": er["helio_lat_deg"],
                "carrington_lon_deg": er["carrington_lon_deg"],
            })
        except Exception as e:
            print(f"[stage-2/jwst] {f}: {e}", file=sys.stderr)
            traceback.print_exc()

    out = pd.DataFrame(rows)
    if not out.empty:
        out = out.sort_values("timestamp")
        print(f"[stage-2] jwst_registered: {len(out)} observations across "
              f"{out['body'].nunique()} bodies")
        print(out.groupby("body")[["instrument", "filter"]].agg(
            lambda s: s.value_counts().to_dict()).to_string())
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
    print(f"[stage-2] perihelion={PERIHELION}")

    eph = load_ephemeris_long(token)
    if eph.empty:
        print("[stage-2] no ephemeris files — run stage-1 first", file=sys.stderr)
        return 1

    out_dir = Path("helio_cache/coords")
    out_dir.mkdir(parents=True, exist_ok=True)

    eph_path = out_dir / f"ephemeris_long_{PERIHELION}.parquet"
    eph.to_parquet(eph_path, compression="snappy")

    eph_psp = eph[eph["body"] == "PSP"]
    if eph_psp.empty:
        print("[stage-2] WARN: no PSP ephemeris in eph; PSP registration skipped",
              file=sys.stderr)
    else:
        psp_reg = register_psp(token, eph_psp)
        if not psp_reg.empty:
            psp_reg.to_parquet(out_dir / f"psp_registered_{PERIHELION}.parquet",
                                compression="snappy")

    jwst_reg = register_jwst(token, eph)
    if not jwst_reg.empty:
        jwst_reg.to_parquet(out_dir / f"jwst_registered_{PERIHELION}.parquet",
                             compression="snappy")
    else:
        print("[stage-2] no JWST observations registered")

    probes_reg = register_probes(token, eph)
    if not probes_reg.empty:
        probes_reg.to_parquet(out_dir / f"probes_registered_{PERIHELION}.parquet",
                                compression="snappy")
    else:
        print("[stage-2] no HSO probe data registered")

    from hf_push import push_folder
    push_folder(api, REPO_ID, out_dir, "coords",
                 f"stage-2: heliographic registration {PERIHELION}",
                 allow_patterns=[f"*_{PERIHELION}.parquet"])
    print(f"[stage-2] pushed coords/ for {PERIHELION} as one commit")

    print("[stage-2] done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
