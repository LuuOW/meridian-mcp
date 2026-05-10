"""
Gradio app for the Meridian stellar harvest-forecast.

Runs at huggingface.co/spaces/luuow/meridian-stellar-explorer.

Lets a visitor pick a JWST target/visit/order from the projection table and
see (a) its sun-archetype assignment, (b) the predicted 48h harvest drift,
(c) the underlying spectral fingerprint. Pulls everything live from
luuow/meridian-stellar-cache.
"""
from __future__ import annotations

import json
import os
import gradio as gr
import pandas as pd
from huggingface_hub import hf_hub_download

REPO_ID = "luuow/meridian-stellar-cache"

ARCHETYPE_NAMES = {0: "planet", 1: "cruise", 2: "comet", 3: "moon", 4: "irregular", 5: "asteroid"}


def _grab(path: str) -> str:
    return hf_hub_download(repo_id=REPO_ID, repo_type="dataset", filename=path)


def _load_artifacts():
    proj = pd.read_parquet(_grab("jwst/projection.parquet"))
    spec = pd.read_parquet(_grab("features/jwst_spectral.parquet"))
    with open(_grab("evaluation/results.json")) as f:
        results = json.load(f)
    with open(_grab("archetypes/centroids.json")) as f:
        centroids = json.load(f)
    return proj, spec, results, centroids


PROJ, SPEC, RESULTS, CENTROIDS = _load_artifacts()


def _row_label(row) -> str:
    inst = "NIRSpec NRS1" if int(row["order"]) == 0 else f"NIRISS Order {int(row['order'])}"
    return f"{row['target']} · {inst}"


PROJ["row_label"] = PROJ.apply(_row_label, axis=1)
ROW_LABELS = PROJ["row_label"].tolist()


def explore(row_label: str):
    row = PROJ[PROJ["row_label"] == row_label].iloc[0]
    arche = int(row["assigned_archetype"])
    drift = float(row["predicted_drift_dex_at_chosen_h"])
    dist = float(row["distance_to_centroid_z"])

    spec_row = SPEC[
        (SPEC["target"] == row["target"]) & (SPEC["order"] == row["order"])
    ].iloc[0] if not SPEC.empty else None

    factor = 10.0 ** drift
    drift_pct = (factor - 1.0) * 100.0

    summary = (
        f"**Target:** {row['target']}\n\n"
        f"**Instrument · order:** {row_label.split(' · ', 1)[1]}\n\n"
        f"**Assigned sun-archetype:** {arche} ({ARCHETYPE_NAMES.get(arche, '?')})\n\n"
        f"**Distance to nearest centroid:** {dist:.3f} z-units\n\n"
        f"**Predicted 48h drift:** {drift:+.3f} dex  →  E_{{t+48h}} ≈ E_t × {factor:.3f} ({drift_pct:+.1f}%)\n\n"
        f"---\n\n"
        f"**Caveat.** Cross-domain z-projection is a strong assumption — PSP and JWST measure different physics.\n"
        f"This is the relative-to-peers projection, not a calibrated radiative forecast for {row['target']}."
    )

    fingerprint_md = ""
    if spec_row is not None:
        fingerprint_md = (
            f"| feature | value |\n|---|---|\n"
            f"| λ_peak (μm) | {spec_row['lambda_peak_um']:.4f} |\n"
            f"| φ entropy | {spec_row['phi_entropy']:.4f} |\n"
            f"| p asymmetry | {spec_row['p_asymmetry']:+.4f} |\n"
            f"| a amplitude | {spec_row['a_amplitude']:.4f} |\n"
        )

    centroid_orig = CENTROIDS["centroids_orig_units"][arche]
    centroid_md = (
        f"**Matched archetype centroid (PSP, original units):**\n\n"
        f"| feature | value |\n|---|---|\n"
        f"| λ_peak (Hz) | {centroid_orig[0]:.4f} |\n"
        f"| φ entropy | {centroid_orig[1]:.4f} |\n"
        f"| p polarization | {centroid_orig[2]:.4f} |\n"
        f"| a amplitude | {centroid_orig[3]:.4f} |\n"
        f"| τ_c (s) | {centroid_orig[4]:.2f} |\n"
    )
    return summary, fingerprint_md, centroid_md


with gr.Blocks(title="Meridian Stellar Explorer", theme=gr.themes.Soft(primary_hue="indigo")) as demo:
    gr.Markdown(
        "## Meridian Stellar Harvest-Forecast — JWST Explorer\n"
        "Pick a JWST target/instrument-order to see the assigned sun-archetype + predicted 48h harvest drift.\n"
        "Live data from [luuow/meridian-stellar-cache](https://huggingface.co/datasets/luuow/meridian-stellar-cache). "
        "[Full write-up](https://ask-meridian.uk/blog/stellar-harvest-forecast/) · "
        "[Live dashboard](https://stellar.ask-meridian.uk/)."
    )
    with gr.Row():
        with gr.Column(scale=1):
            row_pick = gr.Dropdown(choices=ROW_LABELS, value=ROW_LABELS[0], label="JWST observation")
            run_btn = gr.Button("Project", variant="primary")
        with gr.Column(scale=2):
            summary_out = gr.Markdown(label="Projection")
    with gr.Row():
        with gr.Column():
            gr.Markdown("### JWST spectral fingerprint")
            fp_out = gr.Markdown()
        with gr.Column():
            gr.Markdown("### Matched sun-archetype centroid")
            centroid_out = gr.Markdown()
    run_btn.click(explore, inputs=[row_pick], outputs=[summary_out, fp_out, centroid_out])
    demo.load(explore, inputs=[row_pick], outputs=[summary_out, fp_out, centroid_out])

if __name__ == "__main__":
    demo.launch()
