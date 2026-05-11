#!/usr/bin/env python3
"""
Stage 7 (housekeeping) — dataset health summary.

Reads everything on `luuow/meridian-helio-mirror`, categorises by stage,
counts per-perihelion completeness, and pushes a single JSON the dashboard
can render as "pipeline state at a glance".
"""
from __future__ import annotations

import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

import pandas as pd
from huggingface_hub import HfApi, hf_hub_download, list_repo_files

from targets import PERIHELIA, BODIES

REPO_ID = "luuow/meridian-helio-mirror"
PERIHELION_TAGS = list(PERIHELIA.keys())
STAGES = {
    "raw_psp": "psp/",
    "raw_jwst": "jwst/",
    "raw_ephemeris": "ephemeris/",
    "raw_probes": "probes/",
    "registered": "coords/",
    "events": "events/",
    "irradiance": "irradiance/",
    "forecast": "forecast/",
    "status": "status/",
    "gates": "gates/",
}


def main() -> int:
    if "HF_TOKEN" not in os.environ:
        print("ERROR: HF_TOKEN not set", file=sys.stderr)
        return 1
    token = os.environ["HF_TOKEN"]
    api = HfApi(token=token)

    files = list_repo_files(REPO_ID, repo_type="dataset", token=token)
    print(f"[status] dataset has {len(files)} files")

    by_stage: dict[str, list[str]] = defaultdict(list)
    for f in files:
        for label, prefix in STAGES.items():
            if f.startswith(prefix):
                by_stage[label].append(f)
                break

    per_perihelion: dict[str, dict] = defaultdict(lambda: defaultdict(int))
    for label, fs in by_stage.items():
        for f in fs:
            for tag in PERIHELION_TAGS:
                if f.endswith(f"{tag}.parquet") or f.endswith(f"{tag}.json") \
                   or f"_{tag}_" in f or f.endswith(f"{tag}.fits"):
                    per_perihelion[tag][label] += 1
                    break
            else:
                per_perihelion["unscoped"][label] += 1

    bodies_present: set[str] = set()
    for f in by_stage.get("raw_jwst", []) + by_stage.get("raw_ephemeris", []):
        for body_name in BODIES:
            if f"/{body_name}/" in f or f"/{body_name}_" in f:
                bodies_present.add(body_name)
    bodies_present.discard("PSP")

    # Per-perihelion HSO probe count from probes/{sc}_mag_{P}.parquet
    probes_per_perihelion: dict[str, list[str]] = defaultdict(list)
    for f in by_stage.get("raw_probes", []):
        m = re.match(r"probes/(.+)_mag_(E\d+)\.parquet$", f)
        if m:
            sc, tag = m.group(1), m.group(2)
            probes_per_perihelion[tag].append(sc.replace("_", "-"))

    # Per-perihelion gate summary: read every gates/{stage}_{P}.json so the
    # dashboard can show pass/fail pills per stage.
    gates_per_perihelion: dict[str, dict] = defaultdict(dict)
    for f in by_stage.get("gates", []):
        m = re.match(r"gates/(.+)_(E\d+)\.json$", f)
        if not m:
            continue
        stage, tag = m.group(1), m.group(2)
        try:
            p = hf_hub_download(repo_id=REPO_ID, repo_type="dataset",
                                 filename=f, token=token)
            data = json.loads(Path(p).read_text())
            gates_per_perihelion[tag][stage] = {
                "ok": bool(data.get("ok")),
                "n_inputs": data.get("n_inputs"),
                "n_outputs": data.get("n_outputs"),
                "duration_sec": data.get("duration_sec"),
                "reason": data.get("reason"),
            }
        except Exception as e:
            print(f"[status] gate read failed for {f}: {e}", file=sys.stderr)

    summary = {
        "generated_at": pd.Timestamp.utcnow().isoformat(),
        "repo": f"https://huggingface.co/datasets/{REPO_ID}",
        "n_files_total": len(files),
        "n_files_by_stage": {k: len(v) for k, v in by_stage.items()},
        "bodies_with_data": sorted(bodies_present),
        "perihelia_processed": sorted(
            tag for tag in PERIHELION_TAGS
            if per_perihelion.get(tag, {}).get("forecast", 0) > 0
        ),
        "probes_per_perihelion": {
            tag: sorted(probes_per_perihelion.get(tag, []))
            for tag in PERIHELION_TAGS
        },
        "gates_per_perihelion": {
            tag: dict(gates_per_perihelion.get(tag, {}))
            for tag in PERIHELION_TAGS
        },
        "per_perihelion_completeness": {
            tag: dict(per_perihelion[tag]) for tag in PERIHELION_TAGS
        },
        "stage_pipeline_order": list(STAGES.keys()),
    }
    print(json.dumps(summary, indent=2, default=str))

    out_dir = Path("helio_cache/forecast")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "dataset_status.json"
    out_path.write_text(json.dumps(summary, indent=2, default=str))
    from hf_push import push as _push
    _push(api, REPO_ID, out_path, "forecast/dataset_status.json",
          "status: dataset health summary")
    print(f"[status] pushed forecast/dataset_status.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
