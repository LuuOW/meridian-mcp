#!/usr/bin/env python3
"""
Stage 7 — project JWST spectral fingerprints onto PSP-derived sun archetypes.

We cannot match JWST features (λ in μm, photon flux) to PSP features (λ in Hz,
magnetic field) in their native units. The projection therefore z-scores each
dataset *independently* using its own mean/std and matches in z-space. This
encodes the assumption: "where this JWST target sits relative to its peers
maps to where the corresponding PSP window sits relative to its peers."
That is a strong assumption; we report it openly and let Gate-3 evaluate
whether the resulting assignments are stable and sensible.

For each JWST (target, visit, order) row:
  1. Build the 5-vector  (λ_peak, φ, p, a, τ_c)  from spectral + variability.
  2. Z-score the row using the JWST sample statistics.
  3. Find the nearest PSP archetype centroid (already z-scored) by Euclidean
     distance.
  4. Apply the chosen-horizon specialist for that archetype to predict the
     drift in (z-scored) feature space, then re-scale to physical drift.

Outputs:
  jwst/projection.parquet — one row per (target, visit, order) with
       projected archetype, distance to centroid, predicted drift.
  evaluation/gate_3.json — stability + sensibility verdict.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from huggingface_hub import HfApi, hf_hub_download

REPO_ID = "luuow/meridian-stellar-cache"
PSP_FEATURE_COLS = ["lambda_peak_hz", "phi_entropy", "p_polarization", "a_amplitude", "tau_c_sec"]
JWST_FEATURE_COLS = ["lambda_peak_um", "phi_entropy", "p_asymmetry", "a_amplitude", "tau_c_sec"]


def grab(filename: str, token: str) -> str:
    return hf_hub_download(repo_id=REPO_ID, repo_type="dataset", filename=filename, token=token)


def main() -> int:
    if "HF_TOKEN" not in os.environ:
        print("ERROR: HF_TOKEN not set", file=sys.stderr)
        return 1
    token = os.environ["HF_TOKEN"]

    spec = pd.read_parquet(grab("features/jwst_spectral.parquet", token))
    var = pd.read_parquet(grab("features/jwst_variability.parquet", token))
    with open(grab("archetypes/centroids.json", token)) as f:
        centroids = json.load(f)
    with open(grab("specialists/specialists.json", token)) as f:
        specialists_meta = json.load(f)

    print(f"[stage-7] spectral rows: {len(spec)}")
    print(f"[stage-7] variability rows: {len(var)}")
    print(f"[stage-7] PSP centroids k={centroids['k']}")

    # Aggregate per (target, visit, order): take median across duplicates,
    # join τ_c from variability table.
    spec_agg = (
        spec.groupby(["target", "visit", "order"], as_index=False)
            .agg(lambda_peak_um=("lambda_peak_um", "median"),
                 phi_entropy=("phi_entropy", "median"),
                 p_asymmetry=("p_asymmetry", "median"),
                 a_amplitude=("a_amplitude", "median"))
    )
    var_agg = (
        var.groupby(["target", "visit", "order"], as_index=False)
           .agg(tau_c_sec=("tau_c_sec", "median"))
    )
    rows = spec_agg.merge(var_agg, on=["target", "visit", "order"], how="left")
    rows["tau_c_sec"] = rows["tau_c_sec"].fillna(0.0)
    print(f"[stage-7] aggregated rows: {len(rows)}")
    print(rows.to_string(index=False))

    # Z-score JWST features using JWST sample statistics.
    X_jwst = rows[JWST_FEATURE_COLS].to_numpy(dtype=float)
    if len(X_jwst) < 2 or np.any(np.std(X_jwst, axis=0) == 0):
        # Fallback: any zero-std columns get z=0 to avoid division by zero.
        std = np.std(X_jwst, axis=0)
        std[std == 0] = 1.0
    else:
        std = np.std(X_jwst, axis=0)
    mean = np.mean(X_jwst, axis=0)
    Xz_jwst = (X_jwst - mean) / std

    centroids_z = np.array(centroids["means_z"])  # shape (k, 5)
    weights = np.array(centroids["weights"])

    # Nearest-centroid in z-space.
    distances = np.linalg.norm(
        Xz_jwst[:, None, :] - centroids_z[None, :, :], axis=2
    )  # (n_rows, k)
    assigned = np.argmin(distances, axis=1)
    nearest_dist = distances[np.arange(len(distances)), assigned]

    # Apply specialist to predict drift in PSP-feature z-space, scaled back to dex.
    chosen_h = specialists_meta.get("chosen_horizon_hours")
    psp_scaler_mean = np.array(specialists_meta["scaler_mean"]) if specialists_meta.get("scaler_mean") else None
    psp_scaler_scale = np.array(specialists_meta["scaler_scale"]) if specialists_meta.get("scaler_scale") else None
    specialists = specialists_meta.get("specialists", {})

    predicted_drift_dex = []
    used_specialist = []
    for i, c in enumerate(assigned):
        spec_for_c = specialists.get(str(int(c))) or specialists.get(int(c))
        if spec_for_c is None or psp_scaler_mean is None:
            predicted_drift_dex.append(np.nan)
            used_specialist.append(False)
            continue
        # The specialist was trained on PSP features that were z-scored using
        # PSP's own mean/std. We're supplying JWST features z-scored using
        # JWST's mean/std. By construction, the specialist receives a vector
        # that is "the JWST equivalent" of a PSP-z input — apples-to-apples
        # only under our cross-domain z-projection assumption.
        coef = np.array(spec_for_c["coef"])
        intercept = float(spec_for_c["intercept"])
        x = Xz_jwst[i]
        predicted_drift_dex.append(float(coef @ x + intercept))
        used_specialist.append(True)

    rows["assigned_archetype"] = assigned.astype(int)
    rows["distance_to_centroid_z"] = nearest_dist
    rows["predicted_drift_dex_at_chosen_h"] = predicted_drift_dex
    rows["specialist_applied"] = used_specialist
    rows["chosen_horizon_hours"] = chosen_h

    print("\n[stage-7] === per-row projection ===")
    print(rows[["target", "visit", "order", "assigned_archetype", "distance_to_centroid_z",
                "predicted_drift_dex_at_chosen_h"]].to_string(index=False))

    # Gate-3: stability — same (target, instrument, order) should agree on
    # archetype across processing duplicates. With 5 distinct rows after
    # aggregation we mainly check whether different instruments/orders
    # land in distinct archetypes (sensibility).
    gate_3 = {
        "n_rows": int(len(rows)),
        "unique_targets": sorted(rows["target"].unique().tolist()),
        "assignment_distribution": rows["assigned_archetype"].value_counts().sort_index().to_dict(),
        "max_distance_z": float(nearest_dist.max()),
        "median_distance_z": float(np.median(nearest_dist)),
        "instrument_order_to_archetype": [
            {"target": str(t), "order": int(o), "archetype": int(a.mode().iloc[0])}
            for (t, o), a in rows.groupby(["target", "order"])["assigned_archetype"]
        ],
        "chosen_horizon_hours": chosen_h,
    }
    # A reasonable Gate-3 sensibility check: distinct (target, order) pairs
    # should not all collapse onto the same archetype.
    distinct_assignments = set(item["archetype"] for item in gate_3["instrument_order_to_archetype"])
    gate_3["distinct_archetypes_used"] = len(distinct_assignments)
    gate_3["sensible_diversity_pass"] = bool(len(distinct_assignments) >= 2)
    print(f"\n[stage-7] distinct archetypes used across (target, order): {gate_3['distinct_archetypes_used']}")
    print(f"[stage-7] Gate-3 sensible-diversity (≥2 archetypes): {'PASS' if gate_3['sensible_diversity_pass'] else 'FAIL'}")
    print(f"[stage-7] median distance to nearest centroid: {gate_3['median_distance_z']:.3f} (z-units)")

    out_dir = Path("stellar_cache/jwst")
    out_dir.mkdir(parents=True, exist_ok=True)
    proj_path = out_dir / "projection.parquet"
    rows.to_parquet(proj_path, compression="snappy")

    eval_dir = Path("stellar_cache/evaluation")
    eval_dir.mkdir(parents=True, exist_ok=True)
    gate_path = eval_dir / "gate_3.json"
    with open(gate_path, "w") as f:
        json.dump(gate_3, f, indent=2, default=str)

    api = HfApi(token=token)
    api.upload_file(
        path_or_fileobj=str(proj_path),
        path_in_repo="jwst/projection.parquet",
        repo_id=REPO_ID, repo_type="dataset",
        commit_message="stage-7: jwst projection onto sun archetypes",
    )
    api.upload_file(
        path_or_fileobj=str(gate_path),
        path_in_repo="evaluation/gate_3.json",
        repo_id=REPO_ID, repo_type="dataset",
        commit_message=f"stage-7: gate-3 {'PASS' if gate_3['sensible_diversity_pass'] else 'FAIL'}",
    )
    print(f"[stage-7] pushed projection + gate_3 to https://huggingface.co/datasets/{REPO_ID}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
