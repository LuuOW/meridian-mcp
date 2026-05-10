#!/usr/bin/env python3
"""
Stage 2 — PSP feature extraction.

Reads every raw/psp/*.parquet from the HF dataset, computes (λ, φ, p, a, τ_c)
on rolling 1-hour windows over (B_R, B_T, B_N), writes features back as
features/psp_features.parquet on the same dataset. Resource-reuse rule:
window-level features are cached; re-running this script overwrites them but
never recomputes the raw ingest.
"""

from __future__ import annotations

import io
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from scipy import signal
from huggingface_hub import HfApi, hf_hub_download

REPO_ID = "luuow/meridian-stellar-cache"
WINDOW_SECONDS = 3600.0
NPERSEG = 1024
MIN_SAMPLES = 1024
EPS = 1e-30


def features_from_window(
    t_sec: np.ndarray,
    br: np.ndarray,
    bt: np.ndarray,
    bn: np.ndarray,
) -> dict:
    """Compute (λ, φ, p, a, τ_c) on one rolling window."""
    n = len(t_sec)
    if n < MIN_SAMPLES:
        return {}

    bmag = np.sqrt(br * br + bt * bt + bn * bn)

    # Linear detrend to suppress DC + slow drift; we want the dynamics.
    br_d = signal.detrend(br, type="linear")
    bt_d = signal.detrend(bt, type="linear")
    bn_d = signal.detrend(bn, type="linear")
    bmag_d = signal.detrend(bmag, type="linear")

    dt = float(np.median(np.diff(t_sec)))
    if not np.isfinite(dt) or dt <= 0:
        return {}
    fs = 1.0 / dt

    # PSD of |B|
    nperseg = min(NPERSEG, n)
    f, psd = signal.welch(bmag_d, fs=fs, nperseg=nperseg, detrend=False)
    nz = (f > 0) & np.isfinite(psd) & (psd > 0)
    if nz.sum() < 4:
        return {}
    f, psd = f[nz], psd[nz]
    psd_n = psd / psd.sum()

    # λ — weighted-mean PSD frequency (Hz). Robust across regimes vs argmax.
    lambda_peak = float(np.sum(f * psd_n))

    # φ — Shannon entropy of PSD distribution, normalised to [0, 1].
    phi = float(-np.sum(psd_n * np.log(psd_n + EPS)) / np.log(len(psd_n)))

    # p — magnetic anisotropy via minimum-variance analysis.
    # eig_max ≫ eig_min implies a structured (planar/Alfvenic) field;
    # near-isotropic implies turbulent / depolarized.
    cov = np.cov(np.vstack([br_d, bt_d, bn_d]))
    eigs = np.sort(np.linalg.eigvalsh(cov))[::-1]
    if eigs[0] <= 0:
        return {}
    p = float(1.0 - eigs[2] / eigs[0])

    # a — log10 of |B| RMS amplitude (after detrend).
    rms = float(np.sqrt(np.mean(bmag_d * bmag_d)))
    a = float(np.log10(rms + EPS))

    # τ_c — first lag where |ACF(|B|)| drops below 1/e (e-folding time).
    x = bmag_d - bmag_d.mean()
    sx = x.std()
    tau_c = 0.0
    if sx > 0:
        x = x / sx
        max_lag = min(n // 2, 4096)
        # Fast normalised ACF via FFT
        nfft = 1 << int(np.ceil(np.log2(2 * n)))
        F = np.fft.rfft(x, n=nfft)
        acf = np.fft.irfft(F * np.conj(F), n=nfft)[:max_lag] / np.arange(n, n - max_lag, -1)
        if acf[0] > 0:
            acf = acf / acf[0]
            below = np.where(np.abs(acf) < 1.0 / np.e)[0]
            tau_c = float(below[0] * dt) if below.size else float(max_lag * dt)

    return {
        "lambda_peak_hz": lambda_peak,
        "phi_entropy": phi,
        "p_polarization": p,
        "a_amplitude": a,
        "tau_c_sec": tau_c,
        "n_samples": int(n),
        "dt_sec": dt,
    }


def process_psp_file(path: str, source_name: str) -> pd.DataFrame:
    df = pd.read_parquet(path)
    df = df.dropna(subset=["B_R", "B_T", "B_N"]).reset_index(drop=True)
    if df.empty:
        return pd.DataFrame()

    t_ns = df["time"].astype("int64").to_numpy()
    t_sec = t_ns / 1e9

    rows = []
    win_start = float(t_sec[0])
    win_end_global = float(t_sec[-1])

    while win_start + WINDOW_SECONDS <= win_end_global:
        win_end = win_start + WINDOW_SECONDS
        idx0 = np.searchsorted(t_sec, win_start, side="left")
        idx1 = np.searchsorted(t_sec, win_end, side="left")
        feats = features_from_window(
            t_sec[idx0:idx1],
            df["B_R"].to_numpy()[idx0:idx1],
            df["B_T"].to_numpy()[idx0:idx1],
            df["B_N"].to_numpy()[idx0:idx1],
        )
        if feats:
            rows.append({
                "source": source_name,
                "win_start": pd.Timestamp(int(win_start * 1e9)),
                "win_end": pd.Timestamp(int(win_end * 1e9)),
                **feats,
            })
        win_start = win_end

    return pd.DataFrame(rows)


def main() -> int:
    if "HF_TOKEN" not in os.environ:
        print("ERROR: HF_TOKEN not set", file=sys.stderr)
        return 1

    api = HfApi(token=os.environ["HF_TOKEN"])
    files = api.list_repo_files(REPO_ID, repo_type="dataset")
    psp_files = [f for f in files if f.startswith("psp/") and f.endswith(".parquet")]
    print(f"[stage-2-psp] found {len(psp_files)} PSP raw file(s)")
    if not psp_files:
        print("[stage-2-psp] no PSP files; nothing to do", file=sys.stderr)
        return 1

    all_rows = []
    for f in psp_files:
        print(f"[stage-2-psp] processing {f}")
        local = hf_hub_download(repo_id=REPO_ID, repo_type="dataset", filename=f, token=os.environ["HF_TOKEN"])
        out = process_psp_file(local, source_name=f)
        print(f"[stage-2-psp]   → {len(out)} window(s)")
        all_rows.append(out)

    feats = pd.concat(all_rows, ignore_index=True) if all_rows else pd.DataFrame()
    if feats.empty:
        print("[stage-2-psp] no feature rows produced", file=sys.stderr)
        return 1

    print(f"[stage-2-psp] total feature rows: {len(feats)}")
    print(feats.describe(include="all").to_string())

    out_dir = Path("stellar_cache/features")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "psp_features.parquet"
    feats.to_parquet(out_path, compression="snappy")
    print(f"[stage-2-psp] wrote {out_path}")

    api.upload_file(
        path_or_fileobj=str(out_path),
        path_in_repo="features/psp_features.parquet",
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message="stage-2: psp features (lambda, phi, p, a, tau_c)",
    )
    print(f"[stage-2-psp] pushed to https://huggingface.co/datasets/{REPO_ID}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
