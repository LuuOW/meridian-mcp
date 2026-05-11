#!/usr/bin/env python3
"""
HF dataset storage audit — walk every file, sum bytes by folder, flag
redundancy (e.g., raw + registered when registered is a superset).

Output: forecast/storage_audit.json with totals and per-folder breakdown.
"""
from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from pathlib import Path

import pandas as pd
from huggingface_hub import HfApi, hf_hub_download, list_repo_files
from huggingface_hub.utils import HfHubHTTPError

REPO_ID = "luuow/meridian-helio-mirror"


def main() -> int:
    if "HF_TOKEN" not in os.environ:
        print("ERROR: HF_TOKEN not set", file=sys.stderr)
        return 1
    token = os.environ["HF_TOKEN"]
    api = HfApi(token=token)

    # Get full file list with sizes via tree API (one round trip per folder)
    by_folder: dict[str, list[dict]] = defaultdict(list)
    total_bytes = 0
    n_files = 0
    try:
        tree = api.list_repo_tree(repo_id=REPO_ID, repo_type="dataset",
                                    recursive=True, token=token)
    except (TypeError, AttributeError):
        # Older huggingface_hub: fall back to walking each folder
        tree = []
        files = list_repo_files(REPO_ID, repo_type="dataset", token=token)
        for f in files:
            # We don't get sizes from list_repo_files; fetch HEAD per file
            # would be expensive — skip sizes in fallback mode
            tree.append(type("F", (), {"path": f, "size": None, "type": "file"})())

    for entry in tree:
        path = getattr(entry, "path", None) or getattr(entry, "rfilename", None)
        size = getattr(entry, "size", None) or getattr(entry, "lfs", None)
        etype = getattr(entry, "type", "file")
        if etype != "file":
            continue
        size_b = int(size) if isinstance(size, (int, float)) else 0
        folder = path.split("/")[0] if "/" in path else "(root)"
        by_folder[folder].append({"path": path, "bytes": size_b})
        total_bytes += size_b
        n_files += 1

    folder_summary = []
    for folder, files in sorted(by_folder.items()):
        folder_bytes = sum(f["bytes"] for f in files)
        folder_summary.append({
            "folder": folder,
            "n_files": len(files),
            "total_bytes": folder_bytes,
            "total_mb": round(folder_bytes / 1024 / 1024, 2),
            "largest_file_mb": round(max((f["bytes"] for f in files), default=0) / 1024 / 1024, 2),
        })
    folder_summary.sort(key=lambda x: -x["total_bytes"])

    # Redundancy heuristics
    redundancy_flags: list[dict] = []
    coords_files = {f["path"]: f["bytes"] for f in by_folder.get("coords", [])}
    psp_files = {f["path"]: f["bytes"] for f in by_folder.get("psp", [])}
    probes_files = {f["path"]: f["bytes"] for f in by_folder.get("probes", [])}

    # coords/psp_registered_{P}.parquet is derived from psp/fields_*.parquet
    # If both exist, the raw psp/ may be droppable for THAT perihelion.
    for cf, csize in coords_files.items():
        if "psp_registered_" not in cf:
            continue
        tag = cf.split("psp_registered_")[1].split(".")[0]
        psp_raw_size = sum(s for p, s in psp_files.items() if tag in p)
        if psp_raw_size > 0:
            redundancy_flags.append({
                "type": "psp_raw_derivable_from_registered",
                "perihelion": tag,
                "raw_size_mb": round(psp_raw_size / 1024 / 1024, 2),
                "registered_size_mb": round(csize / 1024 / 1024, 2),
                "note": "psp_registered_*.parquet contains the same B-field samples plus heliographic coords."
                         " Dropping psp/fields_*.parquet saves storage if you don't need raw CDF traceability.",
            })

    for cf, csize in coords_files.items():
        if "probes_registered_" not in cf:
            continue
        tag = cf.split("probes_registered_")[1].split(".")[0]
        probes_raw_size = sum(s for p, s in probes_files.items() if tag in p)
        if probes_raw_size > 0:
            redundancy_flags.append({
                "type": "probes_raw_derivable_from_registered",
                "perihelion": tag,
                "raw_size_mb": round(probes_raw_size / 1024 / 1024, 2),
                "registered_size_mb": round(csize / 1024 / 1024, 2),
                "note": "probes_registered_*.parquet pools all HSO MAG samples + ephemeris-joined coords."
                         " Dropping probes/*.parquet saves storage but loses per-spacecraft separability.",
            })

    audit = {
        "generated_at": pd.Timestamp.utcnow().isoformat(),
        "total_files": n_files,
        "total_bytes": total_bytes,
        "total_mb": round(total_bytes / 1024 / 1024, 2),
        "folders": folder_summary,
        "redundancy_flags": redundancy_flags,
    }
    print(json.dumps(audit, indent=2))

    out_dir = Path("helio_cache/forecast")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "storage_audit.json"
    out_path.write_text(json.dumps(audit, indent=2))
    from hf_push import push as _push
    _push(api, REPO_ID, out_path, "forecast/storage_audit.json",
          "audit: dataset storage breakdown + redundancy flags")
    print(f"[audit] pushed forecast/storage_audit.json — total {audit['total_mb']} MB across "
          f"{n_files} files; {len(redundancy_flags)} redundancy flags")
    return 0


if __name__ == "__main__":
    sys.exit(main())
