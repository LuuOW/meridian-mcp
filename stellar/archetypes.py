#!/usr/bin/env python3
"""
Stage 3 — archetype clustering on PSP feature vectors.

Loads features/psp_features.parquet, z-scores the (λ, φ, p, a, τ_c) columns,
fits diagonal-covariance GMMs for k = 2..6, picks the best k by BIC, and
saves both the cluster definitions (centroids.json) and per-window labels
(labels.parquet) back to the HF Dataset.

Honesty about sample size:
  diag-cov GMM has 11k - 1 free params for 5-D data; even k=3 needs ~33
  params and we have 23 rows × 5 features = 115 datapoints. We are at the
  edge of what's fittable. The BIC sweep will pick the most defensible k
  given the data we have, and we document the small-sample caveat in the
  saved centroids.json.

Gate-1 evaluation is qualitative — we report cluster centroids and per-cluster
window summaries so we can read whether the regimes make physical sense.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from huggingface_hub import HfApi, hf_hub_download
from sklearn.mixture import GaussianMixture
from sklearn.preprocessing import StandardScaler

REPO_ID = "luuow/meridian-stellar-cache"
FEATURES_FILE = "features/psp_features.parquet"
FEATURE_COLS = [
    "lambda_peak_hz",
    "phi_entropy",
    "p_polarization",
    "a_amplitude",
    "tau_c_sec",
]
K_CANDIDATES = [2, 3, 4, 5, 6]
RANDOM_STATE = 42


def fit_and_score(X: np.ndarray, k: int) -> tuple:
    gmm = GaussianMixture(
        n_components=k,
        covariance_type="diag",
        n_init=10,
        max_iter=500,
        reg_covar=1e-4,
        random_state=RANDOM_STATE,
    )
    gmm.fit(X)
    return gmm, float(gmm.bic(X)), float(gmm.score(X) * len(X)), bool(gmm.converged_)


def main() -> int:
    if "HF_TOKEN" not in os.environ:
        print("ERROR: HF_TOKEN not set", file=sys.stderr)
        return 1
    token = os.environ["HF_TOKEN"]

    path = hf_hub_download(repo_id=REPO_ID, repo_type="dataset", filename=FEATURES_FILE, token=token)
    df = pd.read_parquet(path)
    print(f"[stage-3] loaded {len(df)} PSP feature rows")

    X = df[FEATURE_COLS].to_numpy(dtype=float)
    finite = np.all(np.isfinite(X), axis=1)
    if (~finite).sum() > 0:
        print(f"[stage-3] dropping {(~finite).sum()} non-finite rows")
        df = df[finite].reset_index(drop=True)
        X = df[FEATURE_COLS].to_numpy(dtype=float)

    scaler = StandardScaler()
    Xz = scaler.fit_transform(X)

    print(f"[stage-3] n={len(df)} windows, d={X.shape[1]} features")
    print(f"[stage-3] BIC sweep over k = {K_CANDIDATES}")

    bic_records: dict = {}
    best = None
    for k in K_CANDIDATES:
        if k > max(2, len(df) // 3):
            print(f"[stage-3]   k={k}: skipped (n//3 cap)")
            continue
        try:
            gmm, bic, ll, converged = fit_and_score(Xz, k)
            bic_records[k] = {"bic": bic, "log_likelihood": ll, "converged": converged}
            print(f"[stage-3]   k={k}  BIC={bic:.2f}  logL={ll:.2f}  converged={converged}")
            if best is None or bic < best["bic"]:
                best = {"k": k, "bic": bic, "gmm": gmm}
        except Exception as e:
            print(f"[stage-3]   k={k} failed: {e}", file=sys.stderr)

    if best is None:
        print("[stage-3] ERROR no k value succeeded", file=sys.stderr)
        return 1

    k_star = best["k"]
    gmm = best["gmm"]
    labels = gmm.predict(Xz)
    centroids_z = gmm.means_
    centroids_orig = scaler.inverse_transform(centroids_z)

    print(f"\n[stage-3] === best k = {k_star} (BIC = {best['bic']:.2f}) ===")
    df["cluster"] = labels.astype(int)

    for c in range(k_star):
        members = df[df["cluster"] == c]
        n = len(members)
        if n == 0:
            print(f"[stage-3] cluster {c}: empty")
            continue
        print(f"\n[stage-3] cluster {c}  (n={n}, weight={gmm.weights_[c]:.3f})")
        print(f"[stage-3]   centroid (orig units):")
        for col, v in zip(FEATURE_COLS, centroids_orig[c]):
            print(f"[stage-3]     {col:>18} = {v:.4f}")
        print(f"[stage-3]   windows ({n}): {sorted(members['win_start'].dt.strftime('%H:%M').tolist())}")
        print(f"[stage-3]   median in original units:")
        for col in FEATURE_COLS:
            print(f"[stage-3]     {col:>18} = {members[col].median():.4f}")

    # Quality-of-fit metrics
    inter = []
    for i in range(k_star):
        for j in range(i + 1, k_star):
            inter.append(float(np.linalg.norm(centroids_z[i] - centroids_z[j])))
    intra = []
    for c in range(k_star):
        members_z = Xz[labels == c]
        if len(members_z) > 1:
            spread = float(np.mean(np.linalg.norm(members_z - centroids_z[c], axis=1)))
            intra.append(spread)
    print(f"\n[stage-3] separation (z-space):")
    print(f"[stage-3]   inter-centroid mean distance: {np.mean(inter):.3f}")
    print(f"[stage-3]   intra-cluster mean distance : {np.mean(intra):.3f}" if intra else "[stage-3]   intra-cluster mean distance : (singleton clusters)")
    if intra:
        ratio = np.mean(inter) / max(np.mean(intra), 1e-9)
        print(f"[stage-3]   separation ratio (higher = better): {ratio:.3f}")

    out_dir = Path("stellar_cache/archetypes")
    out_dir.mkdir(parents=True, exist_ok=True)

    centroids_payload = {
        "k": int(k_star),
        "feature_cols": FEATURE_COLS,
        "scaler_mean": scaler.mean_.tolist(),
        "scaler_scale": scaler.scale_.tolist(),
        "weights": gmm.weights_.tolist(),
        "means_z": gmm.means_.tolist(),
        "covariances_z": gmm.covariances_.tolist(),
        "covariance_type": "diag",
        "centroids_orig_units": centroids_orig.tolist(),
        "bic_sweep": bic_records,
        "n_windows": int(len(df)),
        "small_sample_caveat": (
            f"Fit on {len(df)} windows from one PSP day; expand cache before "
            f"evaluating Gate-1 quantitatively."
        ),
        "random_state": RANDOM_STATE,
    }

    cent_path = out_dir / "centroids.json"
    lab_path = out_dir / "labels.parquet"
    with open(cent_path, "w") as f:
        json.dump(centroids_payload, f, indent=2)
    df.to_parquet(lab_path, compression="snappy")
    print(f"[stage-3] wrote {cent_path} and {lab_path}")

    api = HfApi(token=token)
    api.upload_file(
        path_or_fileobj=str(cent_path),
        path_in_repo="archetypes/centroids.json",
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message=f"stage-3: archetype centroids (k={k_star}, BIC-selected)",
    )
    api.upload_file(
        path_or_fileobj=str(lab_path),
        path_in_repo="archetypes/labels.parquet",
        repo_id=REPO_ID,
        repo_type="dataset",
        commit_message=f"stage-3: per-window archetype labels (k={k_star})",
    )
    print(f"[stage-3] pushed to https://huggingface.co/datasets/{REPO_ID}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
