#!/usr/bin/env python3
"""
Stage 5 — reflection calibrator.

For each JWST aggregate (per-FITS brightness measurement of a body), invert
the planetary photometry to recover a per-observation proxy for the *solar
irradiance arriving at the body's heliocentric position* at observation time.

Standard equation (Lambertian disk, optically thick):
  F_obs ∝ I_solar(at body) × A_bond × R_body² × Φ(α) / (Δ²)
where Δ is body-to-observer distance and Φ(α) is the disk-integrated phase
function. Solving:
  I_solar(at body) ∝ F_obs × Δ² / (A_bond × R_body² × Φ(α))

We track the right-hand side per (body, filter, t). The proportionality
constant absorbs FITS unit conventions and band integration — within a
single (body, filter) the time-series is comparable; across bodies/filters
it's an apples-vs-apples-of-different-rotations rough indicator.

JWST observer position is approximated as Earth at L2 — the ~0.01 AU offset
is negligible vs the body distances of interest (Mars 0.5-2.5, Jupiter 4-6,
Saturn 8-11 AU).

Outputs:
  irradiance/delivered_{PERIHELION}.parquet — per (body, filter, t)
    inferred-irradiance proxy + phase angle + body distances
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
AU_KM = 149_597_870.7

BODY_PHOTOMETRY = {
    "Mars":      {"radius_km": 3389.5,  "bond_albedo": 0.250},
    "Jupiter":   {"radius_km": 69911.0, "bond_albedo": 0.503},
    "Saturn":    {"radius_km": 58232.0, "bond_albedo": 0.342},
    "Mercury":   {"radius_km": 2440.0,  "bond_albedo": 0.119},
    "Venus":     {"radius_km": 6051.8,  "bond_albedo": 0.760},
    "Uranus":    {"radius_km": 25362.0, "bond_albedo": 0.300},
    "Neptune":   {"radius_km": 24622.0, "bond_albedo": 0.290},
    "Europa":    {"radius_km": 1560.8,  "bond_albedo": 0.670},
    "Io":        {"radius_km": 1821.6,  "bond_albedo": 0.630},
    "Ganymede":  {"radius_km": 2634.1,  "bond_albedo": 0.350},
    "Callisto":  {"radius_km": 2410.3,  "bond_albedo": 0.220},
    "Titan":     {"radius_km": 2574.7,  "bond_albedo": 0.220},
    "Enceladus": {"radius_km": 252.1,   "bond_albedo": 0.810},
}


def push(api: HfApi, local: Path, repo_path: str, message: str) -> None:
    api.upload_file(
        path_or_fileobj=str(local),
        path_in_repo=repo_path,
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message=message,
    )


def lambertian_disk_phase(alpha_rad: np.ndarray) -> np.ndarray:
    return (np.sin(alpha_rad) + (np.pi - alpha_rad) * np.cos(alpha_rad)) / np.pi


def phase_angle_rad(body_xyz_au: np.ndarray, observer_xyz_au: np.ndarray) -> np.ndarray:
    body_to_sun = -body_xyz_au
    body_to_obs = observer_xyz_au - body_xyz_au
    cos = np.einsum("ij,ij->i", body_to_sun, body_to_obs) / (
        np.linalg.norm(body_to_sun, axis=1) * np.linalg.norm(body_to_obs, axis=1)
    )
    return np.arccos(np.clip(cos, -1.0, 1.0))


def load(token: str, name: str) -> pd.DataFrame:
    files = list_repo_files(REPO_ID, repo_type="dataset", token=token)
    if name not in files:
        print(f"[stage-5] missing {name}", file=sys.stderr)
        return pd.DataFrame()
    p = hf_hub_download(repo_id=REPO_ID, repo_type="dataset", filename=name, token=token)
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

    jwst = load(token, f"events/jwst_aggregates_{PERIHELION}.parquet")
    eph_long = load(token, f"coords/ephemeris_long_{PERIHELION}.parquet")
    if jwst.empty or eph_long.empty:
        print("[stage-5] missing inputs", file=sys.stderr)
        return 1

    earth = eph_long[eph_long["body"] == "Earth"].sort_values("timestamp")
    if earth.empty:
        print("[stage-5] no Earth ephemeris — can't compute phase angle",
              file=sys.stderr)
        return 1

    rows = []
    for _, j in jwst.iterrows():
        body = j["body"]
        photo = BODY_PHOTOMETRY.get(body)
        if photo is None:
            print(f"[stage-5] skip {body}: no photometry constants")
            continue
        ts = pd.Timestamp(j["timestamp"]).tz_localize(None)
        body_xyz = np.array([[j["x_au"], j["y_au"], j["z_au"]]])
        idx = (earth["timestamp"] - ts).abs().idxmin()
        e = earth.loc[idx]
        earth_xyz = np.array([[e["x_au"], e["y_au"], e["z_au"]]])
        alpha = phase_angle_rad(body_xyz, earth_xyz)[0]
        phase_f = lambertian_disk_phase(np.array([alpha]))[0]
        delta_au = float(np.linalg.norm(earth_xyz - body_xyz))
        r_body_au = float(j["r_au"])

        flux = float(j["flux_sum"])
        cross_section_km2 = np.pi * photo["radius_km"] ** 2
        normaliser = photo["bond_albedo"] * cross_section_km2 * max(phase_f, 1e-6)
        delta_km = delta_au * AU_KM
        inferred = flux * (delta_km ** 2) / normaliser
        rows.append({
            "timestamp": ts,
            "body": body,
            "filter": j.get("filter"),
            "instrument": j.get("instrument"),
            "source_file": j["source_file"],
            "flux_sum": flux,
            "flux_units": j.get("bunit"),
            "body_helio_lon_deg": float(j["helio_lon_deg"]),
            "body_helio_lat_deg": float(j["helio_lat_deg"]),
            "body_r_au": r_body_au,
            "observer_r_au": float(e["r_au"]),
            "delta_au": delta_au,
            "phase_angle_deg": float(np.degrees(alpha)),
            "phase_function": float(phase_f),
            "bond_albedo": photo["bond_albedo"],
            "radius_km": photo["radius_km"],
            "inferred_irradiance_proxy": inferred,
            "log10_inferred_irradiance_proxy": float(np.log10(inferred)) if inferred > 0 else None,
        })

    out = pd.DataFrame(rows)
    if out.empty:
        print("[stage-5] no rows produced", file=sys.stderr)
        return 1
    print(f"[stage-5] {len(out)} per-FITS irradiance proxies")
    print(out.groupby(["body", "filter"]).agg({
        "phase_angle_deg": ["mean"],
        "delta_au": ["mean"],
        "inferred_irradiance_proxy": ["median", "min", "max"],
    }).to_string())

    out_dir = Path("helio_cache/irradiance")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"delivered_{PERIHELION}.parquet"
    out.to_parquet(out_path, compression="snappy")
    push(api, out_path, f"irradiance/delivered_{PERIHELION}.parquet",
         f"stage-5: inferred-irradiance proxy per JWST observation {PERIHELION}")
    print("[stage-5] done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
