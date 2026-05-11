"""Shared HF Hub push helpers with 429 / 5xx retry + folder-commit support.

HF free tier caps at 128 commits/hour per repository. Pulling raw data
naively (one upload_file per artifact) blew past that during a five-
perihelion fanout. Two helpers are exposed:

- `push(api, repo_id, local, repo_path, message)` — single-file commit.
  Retries on transient HTTP errors. Use for small infrequent outputs.

- `push_folder(api, repo_id, local_dir, repo_subdir, message, allow_patterns=None)`
  — batches every file under `local_dir` into ONE commit. Use this in
  pull.py and any stage that emits many files at once.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

from huggingface_hub import HfApi
from huggingface_hub.errors import HfHubHTTPError

RETRY_DELAYS_SEC = (2, 5, 15, 45, 120)
RETRY_STATUS_CODES = {429, 500, 502, 503, 504}


def _retry(call, label: str):
    last: Exception | None = None
    for attempt, delay in enumerate(RETRY_DELAYS_SEC):
        try:
            return call()
        except HfHubHTTPError as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status in RETRY_STATUS_CODES:
                last = e
                print(f"[hf_push] HF {status} on {label}; retry in {delay}s "
                      f"(attempt {attempt+1}/{len(RETRY_DELAYS_SEC)})",
                      file=sys.stderr)
                time.sleep(delay)
                continue
            raise
    if last is not None:
        raise last


def push(api: HfApi, repo_id: str, local: Path | str, repo_path: str,
         message: str, repo_type: str = "dataset") -> None:
    _retry(lambda: api.upload_file(
        path_or_fileobj=str(local),
        path_in_repo=repo_path,
        repo_id=repo_id,
        repo_type=repo_type,
        commit_message=message,
    ), repo_path)


def push_folder(api: HfApi, repo_id: str, local_dir: Path | str,
                repo_subdir: str, message: str,
                allow_patterns: list[str] | None = None,
                repo_type: str = "dataset") -> None:
    _retry(lambda: api.upload_folder(
        folder_path=str(local_dir),
        path_in_repo=repo_subdir,
        repo_id=repo_id,
        repo_type=repo_type,
        commit_message=message,
        allow_patterns=allow_patterns,
    ), f"folder:{repo_subdir}")
