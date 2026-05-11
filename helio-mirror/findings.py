#!/usr/bin/env python3
"""
Portfolio findings generator — reads all stage outputs and writes a
human-readable markdown summary suitable for a resume / project page.

Pulls from:
  forecast/latest.json (or latest_{P}.json for a specific perihelion)
  forecast/dataset_status.json
  events/coincidences_summary_{P}.json
  gates/{stage}_{P}.json

Produces:
  findings/FINDINGS.md         — one canonical summary across perihelia
  findings/FINDINGS_{P}.md     — per-perihelion summary

Run independently (workflow_dispatch). Cheap, no heavy compute.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pandas as pd
from huggingface_hub import HfApi, hf_hub_download, list_repo_files

from targets import PERIHELIA

REPO_ID = "luuow/meridian-helio-mirror"


def fetch_json(token: str, name: str, files: list[str]) -> dict | None:
    if name not in files:
        return None
    try:
        p = hf_hub_download(repo_id=REPO_ID, repo_type="dataset",
                             filename=name, token=token)
        return json.loads(Path(p).read_text())
    except Exception as e:
        print(f"[findings] {name}: {e}", file=sys.stderr)
        return None


def emit_perihelion(tag: str, latest: dict | None, summary: dict | None,
                     gates: dict[str, dict]) -> str:
    if not latest:
        return f"## {tag} — no forecast yet\n\n"
    lines: list[str] = []
    lines.append(f"## {tag}\n")
    psp = latest.get("psp") or {}
    lines.append(f"- PSP perihelion at r = **{psp.get('r_au', '?')}** AU, "
                  f"helio lon **{psp.get('lon_deg', '?')}°**, "
                  f"{latest.get('n_total_psp_events', '?')} PVI/WISPR/SEP events.")
    probes = latest.get("probes") or {}
    lines.append(f"- HSO probes loaded: **{len(probes)}** "
                  f"({', '.join(sorted(probes.keys())) or '—'}).")
    matched = latest.get("n_probe_coincidences_matched")
    cand = latest.get("n_probe_coincidences_candidate")
    score = latest.get("median_probe_match_score")
    if matched is not None:
        lines.append(f"- Probe×probe coincidences: **{matched}** matched / "
                      f"**{cand}** candidates "
                      f"(median match score **{score:.2f}**)." if score is not None
                      else f"- Probe×probe coincidences: **{matched}** matched / **{cand}** candidates.")
    pairs = latest.get("probe_pairs_by_pair") or []
    if pairs:
        pair_strs = ", ".join(f"{p['source_spacecraft']}→{p['target_spacecraft']}: {p['n']}"
                               for p in sorted(pairs, key=lambda x: -x.get("n", 0)))
        lines.append(f"- Pair breakdown: {pair_strs}.")

    # Null test verdict (if it's been run for this perihelion)
    null_data = summary.get("__null_test__") if isinstance(summary, dict) else None
    if null_data:
        verdict = null_data.get("verdict", "?")
        verdict_marker = ("**SIGNIFICANT**" if verdict == "significant"
                           else "marginal" if verdict == "marginal"
                           else "_indistinguishable from null_")
        lines.append(f"- Null test (n={null_data.get('n_shuffles')}, mode={null_data.get('mode','loose')}): "
                      f"observed {null_data.get('observed_matched')} vs null mean "
                      f"{null_data.get('null_matches_mean'):.1f} · z={null_data.get('z_score')} · "
                      f"p={null_data.get('p_value_one_sided')} → {verdict_marker}.")
    if gates:
        passed = sum(1 for g in gates.values() if g.get("ok"))
        lines.append(f"- Stage gates: **{passed}/{len(gates)}** pass.")
    bodies = latest.get("bodies") or {}
    if bodies:
        lines.append(f"- Forecast bodies: **{len(bodies)}** "
                      f"({', '.join(sorted(bodies.keys()))}).")
    lines.append(f"- Model: `{latest.get('model', '?')}`. "
                  f"Generated {latest.get('generated_at', '?')}.")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    if "HF_TOKEN" not in os.environ:
        print("ERROR: HF_TOKEN not set", file=sys.stderr)
        return 1
    token = os.environ["HF_TOKEN"]
    api = HfApi(token=token)
    files = list_repo_files(REPO_ID, repo_type="dataset", token=token)

    status = fetch_json(token, "forecast/dataset_status.json", files) or {}
    out_dir = Path("helio_cache/findings")
    out_dir.mkdir(parents=True, exist_ok=True)

    sections: list[str] = []
    sections.append("# HelioCast — findings\n")
    sections.append(f"_Auto-generated {pd.Timestamp.utcnow().isoformat()}._\n\n")
    sections.append("HSO = Heliophysics System Observatory. A handful of "
                     "operational in-situ spacecraft (PSP, SolO, STEREO-A, Wind, "
                     "ACE, DSCOVR, MAVEN) treated as a single distributed "
                     "observatory for cross-correlating solar-wind structures.\n\n")
    sections.append("## Pipeline state\n")
    sections.append(f"- HF dataset: <{status.get('repo', '?')}>\n")
    sections.append(f"- Total files: **{status.get('n_files_total', '?')}**.\n")
    sections.append(f"- Perihelia with forecasts: "
                     f"{', '.join(status.get('perihelia_processed', [])) or '—'}.\n")
    sections.append(f"- Bodies with JWST + ephemeris data: "
                     f"{', '.join(status.get('bodies_with_data', [])) or '—'}.\n\n")

    gates_per = status.get("gates_per_perihelion", {})
    for tag in PERIHELIA:
        latest_name = f"forecast/latest_{tag}.json"
        latest = fetch_json(token, latest_name, files)
        if latest is None and tag == status.get("perihelia_processed", [None])[-1]:
            latest = fetch_json(token, "forecast/latest.json", files)
        summary = fetch_json(token, f"events/coincidences_summary_{tag}.json", files) or {}
        # Stitch null_test in via __null_test__ key so emit_perihelion can read it
        null_data = fetch_json(token, f"events/null_test_{tag}.json", files)
        if null_data:
            summary["__null_test__"] = null_data
        gates = gates_per.get(tag, {})
        section = emit_perihelion(tag, latest, summary, gates)
        sections.append(section)
        # also per-perihelion file
        (out_dir / f"FINDINGS_{tag}.md").write_text(section)

    text = "".join(sections)
    canonical = out_dir / "FINDINGS.md"
    canonical.write_text(text)
    print(text)

    from hf_push import push_folder
    push_folder(api, REPO_ID, out_dir, "findings",
                 "findings: portfolio-friendly summary",
                 allow_patterns=["FINDINGS*.md"])
    print(f"[findings] pushed findings/ ({len(list(out_dir.glob('*.md')))} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
