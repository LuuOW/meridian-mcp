#!/usr/bin/env python3
"""
Stage 4B — Earth-PSP Parker-spiral connection geometry.

Real-life HelioCast prerequisite: PSP only constrains the future Earth wind
state when the wind sampled at PSP would actually advect to Earth. That
requires PSP and Earth to share the same Parker spiral source-surface
footpoint (within tolerance), which holds only during narrow longitudinal
connection windows around perihelion.

For each PSP feature window we compute:
  - PSP and Earth heliocentric ecliptic positions (JPL Horizons)
  - φ_PSP - φ_Earth in the inertial heliocentric frame (degrees)
  - The Parker-spiral required offset Ω·(r_E - r_PSP)/v_sw at v_sw=400 km/s
  - Whether the actual offset matches the Parker offset within tolerance
  - Advection lead time (r_E - r_PSP)/v_sw — typically 3.4–3.8 days at PSP
    perihelion radii (0.13–0.21 AU)

Output: parker/connection.parquet pushed to the HF dataset, joined to the
PSP feature windows by win_start. Used by the L1 forecast layer to mask
windows where PSP→Earth advection is geometrically valid.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from astroquery.jplhorizons import Horizons
from huggingface_hub import HfApi, hf_hub_download

REPO_ID = "luuow/meridian-stellar-cache"
INPUT_FILE = "harvest/E_truth.parquet"
OUTPUT_FILE = "parker/connection.parquet"

PSP_NAIF = "-96"
EARTH_NAIF = "399"
HELIOCENTRIC_LOCATION = "@sun"

OMEGA_SUN_DEG_PER_DAY = 14.713
OMEGA_SUN_DEG_PER_SEC = OMEGA_SUN_DEG_PER_DAY / 86400.0
V_SW_KM_PER_SEC = 400.0
AU_KM = 149_597_870.7
CONNECTION_TOLERANCE_DEG = 10.0


def query_body(naif_id: str, t_start: pd.Timestamp, t_stop: pd.Timestamp) -> pd.DataFrame:
    obj = Horizons(
        id=naif_id,
        location=HELIOCENTRIC_LOCATION,
        epochs={
            "start": t_start.strftime("%Y-%m-%d %H:%M"),
            "stop": t_stop.strftime("%Y-%m-%d %H:%M"),
            "step": "1h",
        },
    )
    vec = obj.vectors().to_pandas()
    return pd.DataFrame({
        "time_jd": vec["datetime_jd"].astype(float),
        "x_au": vec["x"].astype(float),
        "y_au": vec["y"].astype(float),
        "z_au": vec["z"].astype(float),
        "range_au": vec["range"].astype(float),
    })


def heliocentric_lon_deg(x_au: np.ndarray, y_au: np.ndarray) -> np.ndarray:
    return np.degrees(np.arctan2(y_au, x_au))


def parker_required_offset_deg(r_psp_au: np.ndarray, r_earth_au: np.ndarray,
                                v_sw_km_s: float = V_SW_KM_PER_SEC) -> np.ndarray:
    dr_km = (r_earth_au - r_psp_au) * AU_KM
    return OMEGA_SUN_DEG_PER_SEC * (dr_km / v_sw_km_s)


def wrap_180(deg: np.ndarray) -> np.ndarray:
    return ((deg + 180.0) % 360.0) - 180.0


def advection_hours(r_psp_au: np.ndarray, r_earth_au: np.ndarray,
                    v_sw_km_s: float = V_SW_KM_PER_SEC) -> np.ndarray:
    dr_km = (r_earth_au - r_psp_au) * AU_KM
    return dr_km / v_sw_km_s / 3600.0


def main() -> int:
    if "HF_TOKEN" not in os.environ:
        print("ERROR: HF_TOKEN not set", file=sys.stderr)
        return 1
    token = os.environ["HF_TOKEN"]

    src = hf_hub_download(repo_id=REPO_ID, repo_type="dataset",
                          filename=INPUT_FILE, token=token)
    df = pd.read_parquet(src)
    df["win_start_dt"] = pd.to_datetime(df["win_start"]).dt.tz_localize(None)
    print(f"[stage-4B] loaded {len(df)} feature windows")

    chunks = []
    for peri_name, group in df.groupby("perihelion"):
        t_start = group["win_start_dt"].min()
        t_stop = group["win_start_dt"].max() + pd.Timedelta(hours=2)
        print(f"[stage-4B] {peri_name}: querying Horizons "
              f"{t_start} → {t_stop} ({len(group)} windows)")

        psp = query_body(PSP_NAIF, t_start, t_stop)
        earth = query_body(EARTH_NAIF, t_start, t_stop)
        merged = psp.merge(earth, on="time_jd", suffixes=("_psp", "_earth"))

        psp_lon = heliocentric_lon_deg(merged["x_au_psp"].values,
                                        merged["y_au_psp"].values)
        earth_lon = heliocentric_lon_deg(merged["x_au_earth"].values,
                                          merged["y_au_earth"].values)
        actual_offset = wrap_180(psp_lon - earth_lon)
        required_offset = parker_required_offset_deg(
            merged["range_au_psp"].values, merged["range_au_earth"].values)
        residual = wrap_180(actual_offset - required_offset)

        merged["timestamp"] = pd.to_datetime(merged["time_jd"], unit="D",
                                              origin="julian")
        merged["psp_lon_deg"] = psp_lon
        merged["earth_lon_deg"] = earth_lon
        merged["psp_r_au"] = merged["range_au_psp"]
        merged["earth_r_au"] = merged["range_au_earth"]
        merged["actual_offset_deg"] = actual_offset
        merged["parker_offset_deg"] = required_offset
        merged["connection_residual_deg"] = residual
        merged["parker_connected"] = np.abs(residual) < CONNECTION_TOLERANCE_DEG
        merged["advection_lead_hours"] = advection_hours(
            merged["range_au_psp"].values, merged["range_au_earth"].values)
        merged["perihelion"] = peri_name
        chunks.append(merged)

    horizons_df = pd.concat(chunks, ignore_index=True).sort_values("timestamp")

    df_sorted = df.sort_values("win_start_dt")
    joined = pd.merge_asof(
        df_sorted, horizons_df,
        left_on="win_start_dt",
        right_on="timestamp",
        direction="nearest",
        tolerance=pd.Timedelta("1h30min"),
        suffixes=("", "_h"),
    )

    out_cols = [
        "source", "win_start", "win_end", "perihelion",
        "psp_lon_deg", "earth_lon_deg", "psp_r_au", "earth_r_au",
        "actual_offset_deg", "parker_offset_deg", "connection_residual_deg",
        "parker_connected", "advection_lead_hours",
    ]
    perihelion_col = "perihelion" if "perihelion" in joined.columns else "perihelion_h"
    if perihelion_col != "perihelion":
        joined = joined.rename(columns={perihelion_col: "perihelion"})
    joined = joined[out_cols]

    n_total = len(joined)
    n_connected = int(joined["parker_connected"].sum())
    pct = 100.0 * n_connected / n_total if n_total else 0.0
    print(f"\n[stage-4B] connection summary:")
    print(f"  Parker-connected windows: {n_connected}/{n_total} ({pct:.1f}%)")
    print(f"  Median |residual|: {joined['connection_residual_deg'].abs().median():.2f}°")
    print(f"  Median advection lead: {joined['advection_lead_hours'].median():.1f} h")
    print(f"  Advection lead range: "
          f"{joined['advection_lead_hours'].min():.1f}–"
          f"{joined['advection_lead_hours'].max():.1f} h")
    print(f"\n[stage-4B] connection by perihelion:")
    by_peri = joined.groupby("perihelion")["parker_connected"].agg(
        ["count", "sum", "mean"]).rename(columns={"sum": "connected", "mean": "frac"})
    print(by_peri.to_string())

    out_dir = Path("stellar_cache/parker")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "connection.parquet"
    joined.to_parquet(out_path, compression="snappy")
    print(f"\n[stage-4B] wrote {out_path}")

    connected = joined[joined["parker_connected"]]
    latest_connected = (connected["win_start"].max().isoformat()
                        if not connected.empty else None)
    status = {
        "v_sw_km_s": V_SW_KM_PER_SEC,
        "tolerance_deg": CONNECTION_TOLERANCE_DEG,
        "n_total_windows": int(n_total),
        "n_connected": int(n_connected),
        "fraction_connected": float(n_connected) / n_total if n_total else 0.0,
        "median_advection_lead_hours": float(joined["advection_lead_hours"].median()),
        "advection_lead_hours_p10": float(joined["advection_lead_hours"].quantile(0.1)),
        "advection_lead_hours_p90": float(joined["advection_lead_hours"].quantile(0.9)),
        "median_residual_deg": float(joined["connection_residual_deg"].abs().median()),
        "latest_connected_window": latest_connected,
        "by_perihelion": {
            str(p): {
                "n_windows": int(g["count"]),
                "n_connected": int(g["connected"]),
                "fraction_connected": float(g["frac"]),
            } for p, g in by_peri.iterrows()
        },
    }
    status_path = out_dir / "status.json"
    import json
    status_path.write_text(json.dumps(status, indent=2))
    print(f"[stage-4B] wrote {status_path}")

    api = HfApi(token=token)
    api.upload_file(
        path_or_fileobj=str(out_path),
        path_in_repo=OUTPUT_FILE,
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message="stage-4B: Earth-PSP Parker-spiral connection geometry",
    )
    api.upload_file(
        path_or_fileobj=str(status_path),
        path_in_repo="parker/status.json",
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message="stage-4B: Parker connection summary",
    )
    print(f"[stage-4B] pushed parker/ artifacts to https://huggingface.co/datasets/{REPO_ID}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
