#!/usr/bin/env python3
"""
Stage 2B — JWST feature extraction.

Reads every raw/jwst/.../*x1dints.fits from the HF dataset and produces two
feature streams (per the design diagram):

  features/jwst_spectral.parquet
    one row per (target, visit, order) — wavelength-axis statistics aggregated
    across the visit's integrations. Used by stage-7 archetype matching.

  features/jwst_variability.parquet
    one row per (target, visit, order, wavelength_bin) — coherence time τ_c
    of the per-wavelength flux time-series. Used by stage-7 variability
    transfer.

Same 5-tuple semantics as PSP, but mapped to the spectral domain:

  λ_peak        flux-weighted mean wavelength (μm)
  φ_entropy     normalised Shannon entropy of flux-over-λ distribution
  p_asymmetry   tanh(spectral skewness) — line-shape asymmetry, [-1, 1]
  a_amplitude   log10 integrated flux
  τ_c_sec       e-folding lag of ACF on the per-λ-bin time series across ints
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from astropy.io import fits
from huggingface_hub import HfApi, hf_hub_download

REPO_ID = "luuow/meridian-stellar-cache"
N_WAVELENGTH_BINS = 32
EPS = 1e-30


def features_per_integration(wl: np.ndarray, fl: np.ndarray) -> tuple | None:
    """Return (λ_peak_um, φ, p_asym, a) for one integration's spectrum."""
    valid = np.isfinite(fl) & np.isfinite(wl) & (fl > 0)
    if valid.sum() < 32:
        return None
    wl_v = wl[valid].astype(float)
    fl_v = fl[valid].astype(float)
    total = fl_v.sum()
    if total <= 0:
        return None
    p = fl_v / total

    lambda_peak = float(np.sum(wl_v * p))
    phi = float(-np.sum(p * np.log(p + EPS)) / np.log(len(p)))
    sigma = float(np.sqrt(np.sum((wl_v - lambda_peak) ** 2 * p)))
    if sigma > 0:
        skew = float(np.sum(((wl_v - lambda_peak) / sigma) ** 3 * p))
        p_asym = float(np.tanh(skew))
    else:
        p_asym = 0.0
    a = float(np.log10(total + EPS))
    return lambda_peak, phi, p_asym, a


def tau_c_per_wavelength(flux_2d: np.ndarray, dt_sec: float) -> np.ndarray:
    """For each wavelength column, e-folding lag of ACF across integrations."""
    n_int, n_wl = flux_2d.shape
    out = np.full(n_wl, np.nan)
    if n_int < 8 or not np.isfinite(dt_sec) or dt_sec <= 0:
        return out
    max_lag = max(2, min(n_int // 2, 60))
    nfft = 1 << int(np.ceil(np.log2(2 * n_int)))
    for j in range(n_wl):
        ts = flux_2d[:, j]
        if not np.all(np.isfinite(ts)):
            continue
        x = ts - ts.mean()
        sx = float(x.std())
        if sx <= 0:
            continue
        x = x / sx
        F = np.fft.rfft(x, n=nfft)
        acf = np.fft.irfft(F * np.conj(F), n=nfft)[:max_lag]
        norm = np.arange(n_int, n_int - max_lag, -1)
        if norm[0] <= 0 or acf[0] <= 0:
            continue
        acf = acf / norm
        acf = acf / acf[0]
        below = np.where(np.abs(acf) < 1.0 / np.e)[0]
        out[j] = float(below[0] * dt_sec) if below.size else float(max_lag * dt_sec)
    return out


def process_visit(path: str, source: str) -> tuple[list, list]:
    spectral_rows: list = []
    variability_rows: list = []
    with fits.open(path) as h:
        h0 = h[0].header
        target = str(h0.get("TARGNAME", h0.get("TARGPROP", "unknown"))).strip()
        instrume = str(h0.get("INSTRUME", "")).strip()
        exp_type = str(h0.get("EXP_TYPE", "")).strip()
        visit = str(h0.get("VISIT_ID", h0.get("VISIT", os.path.basename(path)))).strip()

        for ext in h:
            if ext.name != "EXTRACT1D":
                continue
            sporder = int(ext.header.get("SPORDER", 0))
            d = ext.data
            if d is None or "WAVELENGTH" not in d.names or "FLUX" not in d.names:
                continue
            wl_2d = np.asarray(d["WAVELENGTH"], dtype=float)
            fl_2d = np.asarray(d["FLUX"], dtype=float)
            mjd = np.asarray(d["MJD-AVG"], dtype=float)
            int_num = np.asarray(d["INT_NUM"], dtype=int) if "INT_NUM" in d.names else np.arange(len(d))
            if wl_2d.ndim != 2 or wl_2d.shape != fl_2d.shape:
                continue

            n_int, n_lambda = wl_2d.shape
            per_int = []
            for i in range(n_int):
                feats = features_per_integration(wl_2d[i], fl_2d[i])
                if feats is not None:
                    per_int.append(feats)
            if not per_int:
                continue
            arr = np.array(per_int)
            spectral_rows.append(
                {
                    "source": source,
                    "target": target,
                    "instrument": instrume,
                    "exp_type": exp_type,
                    "visit": visit,
                    "order": sporder,
                    "n_integrations": int(arr.shape[0]),
                    "int_num_min": int(int_num.min()),
                    "int_num_max": int(int_num.max()),
                    "lambda_peak_um": float(np.median(arr[:, 0])),
                    "phi_entropy": float(np.median(arr[:, 1])),
                    "p_asymmetry": float(np.median(arr[:, 2])),
                    "a_amplitude": float(np.median(arr[:, 3])),
                    "lambda_peak_um_std": float(arr[:, 0].std()),
                    "a_amplitude_std": float(arr[:, 3].std()),
                }
            )

            wl_med = np.median(wl_2d, axis=0)
            dmjd = np.diff(mjd)
            dmjd = dmjd[np.isfinite(dmjd) & (dmjd > 0)]
            if dmjd.size == 0:
                continue
            dt_sec = float(np.median(dmjd)) * 86400.0
            tau_c_vec = tau_c_per_wavelength(fl_2d, dt_sec)

            edges = np.linspace(0, n_lambda, N_WAVELENGTH_BINS + 1, dtype=int)
            for k in range(N_WAVELENGTH_BINS):
                lo, hi = edges[k], edges[k + 1]
                if hi <= lo:
                    continue
                tau_med = float(np.nanmedian(tau_c_vec[lo:hi]))
                if not np.isfinite(tau_med):
                    continue
                variability_rows.append(
                    {
                        "source": source,
                        "target": target,
                        "visit": visit,
                        "order": sporder,
                        "wavelength_um": float(np.median(wl_med[lo:hi])),
                        "tau_c_sec": tau_med,
                        "n_pts_in_bin": int(hi - lo),
                        "dt_sec": dt_sec,
                    }
                )
    return spectral_rows, variability_rows


def main() -> int:
    if "HF_TOKEN" not in os.environ:
        print("ERROR: HF_TOKEN not set", file=sys.stderr)
        return 1

    api = HfApi(token=os.environ["HF_TOKEN"])
    files = api.list_repo_files(REPO_ID, repo_type="dataset")
    jwst_files = [f for f in files if f.startswith("jwst/") and f.endswith("_x1dints.fits")]
    print(f"[stage-2-jwst] found {len(jwst_files)} JWST x1dints file(s)")
    if not jwst_files:
        print("[stage-2-jwst] no JWST files; nothing to do", file=sys.stderr)
        return 1

    spectral_all: list = []
    variability_all: list = []
    for f in jwst_files:
        print(f"[stage-2-jwst] processing {f}")
        local = hf_hub_download(repo_id=REPO_ID, repo_type="dataset", filename=f, token=os.environ["HF_TOKEN"])
        spec_rows, var_rows = process_visit(local, source=f)
        print(f"[stage-2-jwst]   → spectral={len(spec_rows)} variability={len(var_rows)}")
        spectral_all.extend(spec_rows)
        variability_all.extend(var_rows)

    if not spectral_all and not variability_all:
        print("[stage-2-jwst] no rows produced", file=sys.stderr)
        return 1

    out_dir = Path("stellar_cache/features")
    out_dir.mkdir(parents=True, exist_ok=True)

    spec_df = pd.DataFrame(spectral_all)
    var_df = pd.DataFrame(variability_all)

    print(f"[stage-2-jwst] spectral rows: {len(spec_df)}")
    print(spec_df.describe(include="all").to_string())
    print(f"\n[stage-2-jwst] variability rows: {len(var_df)}")
    print(var_df[["wavelength_um", "tau_c_sec", "n_pts_in_bin", "dt_sec"]].describe().to_string())

    spec_path = out_dir / "jwst_spectral.parquet"
    var_path = out_dir / "jwst_variability.parquet"
    spec_df.to_parquet(spec_path, compression="snappy")
    var_df.to_parquet(var_path, compression="snappy")

    api.upload_file(
        path_or_fileobj=str(spec_path),
        path_in_repo="features/jwst_spectral.parquet",
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message="stage-2: jwst spectral fingerprint per (target, visit, order)",
    )
    api.upload_file(
        path_or_fileobj=str(var_path),
        path_in_repo="features/jwst_variability.parquet",
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message="stage-2: jwst per-wavelength tau_c",
    )
    print(f"[stage-2-jwst] pushed both feature parquets to https://huggingface.co/datasets/{REPO_ID}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
