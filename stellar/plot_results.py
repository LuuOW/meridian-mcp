#!/usr/bin/env python3
"""
Render four SVG plots from the HF Dataset for the blog + dashboard.

  stellar-horizon-sweep.svg     three policies × four horizons, MAE
  stellar-feature-pca.svg       621 PSP windows in PCA-2D, archetype-coloured
  stellar-cross-target.svg      target × instrument-order → archetype matrix
  stellar-stellar-type.svg      M vs G archetype distributions (per inst/order)

Reads from HF Dataset only — no local data inputs. Designed to run from
GitHub Actions or a clean Python env.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from huggingface_hub import hf_hub_download
from sklearn.decomposition import PCA

REPO_ID = "luuow/meridian-stellar-cache"
OUT_DIR = Path(os.environ.get("PLOT_OUT_DIR", "landing/img/blog"))
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Colour palette — keep consistent across all plots, semantic per archetype.
ARCHETYPE_COLORS = {
    0: "#3a8dde",  # planet (steady, polarized)
    1: "#9aa0a6",  # cruise / quiet
    2: "#e15554",  # comet (turbulent)
    3: "#f5a623",  # moon (mixed)
    4: "#7d3cff",  # outlier
    5: "#1cab5d",  # asteroid (narrow-band)
}
ARCHETYPE_NAMES = {
    0: "planet",
    1: "cruise",
    2: "comet",
    3: "moon",
    4: "irregular",
    5: "asteroid",
}


def grab(filename: str, token: str | None = None) -> str:
    return hf_hub_download(repo_id=REPO_ID, repo_type="dataset", filename=filename, token=token)


def setup_axes(ax, title=None, xlabel=None, ylabel=None):
    ax.set_facecolor("#0c0e12")
    for s in ax.spines.values():
        s.set_color("#3a3e47")
    ax.tick_params(colors="#cdd2db", labelsize=9)
    if title:
        ax.set_title(title, color="#f0f2f6", fontsize=11, pad=10)
    if xlabel:
        ax.set_xlabel(xlabel, color="#cdd2db", fontsize=10)
    if ylabel:
        ax.set_ylabel(ylabel, color="#cdd2db", fontsize=10)
    ax.grid(True, color="#2a2e36", linestyle=":", linewidth=0.6)


def fig_setup(figsize=(7.5, 4.5)):
    fig, ax = plt.subplots(figsize=figsize)
    fig.patch.set_facecolor("#0c0e12")
    return fig, ax


def plot_horizon_sweep(token: str | None) -> Path:
    with open(grab("evaluation/results.json", token)) as f:
        r = json.load(f)
    rows = [h for h in r["by_horizon"] if not h.get("skipped") and not h.get("error")]
    horizons = [h["horizon_hours"] for h in rows]
    fixed = [h["policies"]["fixed"]["mae_drift_dex"] for h in rows]
    persist = [h["policies"]["persistence"]["mae_drift_dex"] for h in rows]
    arch = [h["policies"]["archetype"]["mae_drift_dex"] for h in rows]
    pass_mask = [h["gate_2_strict_pass"] for h in rows]

    fig, ax = fig_setup((7.5, 4.5))
    ax.plot(horizons, fixed, "o-", color="#9aa0a6", label="fixed (mean drift)", lw=1.6, ms=6)
    ax.plot(horizons, persist, "o-", color="#e15554", label="persistence (zero drift)", lw=1.6, ms=6)
    ax.plot(horizons, arch, "o-", color="#3a8dde", label="archetype-routed", lw=2.2, ms=7)
    for h, a, p in zip(horizons, arch, pass_mask):
        if p:
            ax.annotate("PASS", xy=(h, a), xytext=(0, -16), textcoords="offset points",
                        ha="center", color="#1cab5d", fontsize=9, fontweight="bold")
    setup_axes(ax, title="Forecast MAE vs horizon — Gate-2 strict",
               xlabel="forecast horizon Δ (hours)",
               ylabel="MAE in log10(E_future / E_now)  (dex; lower is better)")
    leg = ax.legend(facecolor="#15171c", edgecolor="#3a3e47", fontsize=9, loc="upper left")
    for t in leg.get_texts():
        t.set_color("#f0f2f6")
    out = OUT_DIR / "stellar-horizon-sweep.svg"
    fig.tight_layout()
    fig.savefig(out, format="svg")
    plt.close(fig)
    print(f"[plots] wrote {out}")
    return out


def plot_feature_pca(token: str | None) -> Path:
    df = pd.read_parquet(grab("archetypes/labels.parquet", token))
    cols = ["lambda_peak_hz", "phi_entropy", "p_polarization", "a_amplitude", "tau_c_sec"]
    X = df[cols].to_numpy()
    Xn = (X - X.mean(axis=0)) / X.std(axis=0)
    pca = PCA(n_components=2)
    Xp = pca.fit_transform(Xn)
    var = pca.explained_variance_ratio_
    fig, ax = fig_setup((7.5, 5.5))
    for c in sorted(df["cluster"].unique()):
        mask = df["cluster"] == c
        n = int(mask.sum())
        ax.scatter(
            Xp[mask, 0], Xp[mask, 1],
            color=ARCHETYPE_COLORS.get(int(c), "#888"),
            label=f"{int(c)} {ARCHETYPE_NAMES.get(int(c), '?')}  (n={n})",
            s=22, alpha=0.85, edgecolors="#0c0e12", linewidths=0.4,
        )
    setup_axes(
        ax,
        title=f"PSP feature space (PCA-2D, n={len(df)} 1-h windows)",
        xlabel=f"PC1 ({var[0]*100:.1f}% var)",
        ylabel=f"PC2 ({var[1]*100:.1f}% var)",
    )
    leg = ax.legend(facecolor="#15171c", edgecolor="#3a3e47", fontsize=8, loc="best")
    for t in leg.get_texts():
        t.set_color("#f0f2f6")
    out = OUT_DIR / "stellar-feature-pca.svg"
    fig.tight_layout()
    fig.savefig(out, format="svg")
    plt.close(fig)
    print(f"[plots] wrote {out}")
    return out


def plot_cross_target(token: str | None) -> Path:
    df = pd.read_parquet(grab("jwst/projection.parquet", token))
    df = df.copy()
    df["row_label"] = df["target"] + "  ord=" + df["order"].astype(str)
    df = df.sort_values(["target", "order"])
    fig, ax = fig_setup((8.5, max(3.0, 0.45 * len(df) + 1.0)))
    y = np.arange(len(df))
    colors = [ARCHETYPE_COLORS.get(int(c), "#888") for c in df["assigned_archetype"]]
    ax.barh(y, df["distance_to_centroid_z"].to_numpy(), color=colors, edgecolor="#0c0e12")
    for i, (_, row) in enumerate(df.iterrows()):
        ax.text(row["distance_to_centroid_z"] + 0.03, i,
                f"  → {ARCHETYPE_NAMES.get(int(row['assigned_archetype']), '?')}  (drift {row['predicted_drift_dex_at_chosen_h']:+.2f} dex)",
                va="center", color="#f0f2f6", fontsize=9)
    ax.set_yticks(y)
    ax.set_yticklabels(df["row_label"].tolist(), color="#cdd2db", fontsize=9)
    setup_axes(
        ax,
        title="JWST → sun-archetype projection  (3 stars × 9 spectra)",
        xlabel="distance to nearest PSP centroid  (z-units)",
    )
    ax.invert_yaxis()
    out = OUT_DIR / "stellar-cross-target.svg"
    fig.tight_layout()
    fig.savefig(out, format="svg")
    plt.close(fig)
    print(f"[plots] wrote {out}")
    return out


def plot_stellar_type(token: str | None) -> Path:
    df = pd.read_parquet(grab("jwst/projection.parquet", token))
    df = df.copy()
    sun_like = {"WASP-39", "WASP-96"}  # G / G-K
    df["stellar_type"] = df["target"].apply(lambda t: "G/G-K" if t in sun_like else "M-dwarf")
    df["instrument_label"] = df["order"].apply(
        lambda o: "NIRSpec NRS1" if int(o) == 0 else f"NIRISS Order {int(o)}"
    )

    instruments = sorted(df["instrument_label"].unique())
    types = ["M-dwarf", "G/G-K"]

    fig, ax = fig_setup((8.0, 4.5))
    bar_w = 0.36
    base = np.arange(len(instruments))

    for k, t in enumerate(types):
        sub = df[df["stellar_type"] == t]
        # archetypes per instrument label
        per_inst = []
        for inst in instruments:
            sub2 = sub[sub["instrument_label"] == inst]
            if len(sub2) == 0:
                per_inst.append(None)
            else:
                per_inst.append(int(sub2["assigned_archetype"].mode().iloc[0]))
        for i, arche in enumerate(per_inst):
            if arche is None:
                ax.text(base[i] + (k - 0.5) * bar_w, 0.5, "—",
                        ha="center", va="center", color="#666", fontsize=12)
                continue
            ax.bar(base[i] + (k - 0.5) * bar_w, 1, bar_w,
                   color=ARCHETYPE_COLORS.get(arche, "#888"),
                   edgecolor="#0c0e12")
            ax.text(base[i] + (k - 0.5) * bar_w, 0.5,
                    f"{arche}\n{ARCHETYPE_NAMES.get(arche,'?')}",
                    ha="center", va="center", color="#f0f2f6", fontsize=9, fontweight="bold")

    ax.set_xticks(base)
    ax.set_xticklabels(instruments, color="#cdd2db", fontsize=9)
    ax.set_yticks([])
    setup_axes(ax, title="Cross-stellar-type archetype assignment  (left bar: M-dwarf / right bar: G-type)")
    ax.set_xlim(-0.6, len(instruments) - 0.4)
    ax.set_ylim(0, 1.1)
    out = OUT_DIR / "stellar-stellar-type.svg"
    fig.tight_layout()
    fig.savefig(out, format="svg")
    plt.close(fig)
    print(f"[plots] wrote {out}")
    return out


def main() -> int:
    token = os.environ.get("HF_TOKEN")
    plot_horizon_sweep(token)
    plot_feature_pca(token)
    plot_cross_target(token)
    plot_stellar_type(token)
    return 0


if __name__ == "__main__":
    sys.exit(main())
