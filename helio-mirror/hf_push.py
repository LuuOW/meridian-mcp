"""Shared HF Hub push helper with 429 / 5xx retry.

All helio-mirror stages used to have their own copy of `push(api, ...)` which
called `api.upload_file` without retry. HF Hub rate-limits dataset commits at
modest QPS; under fanout this caused 429 failures. Centralising the logic
here means a single retry policy across stages.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

from huggingface_hub import HfApi
from huggingface_hub.errors import HfHubHTTPError

RETRY_DELAYS_SEC = (2, 5, 15, 45, 120)
RETRY_STATUS_CODES = {429, 500, 502, 503, 504}


def push(api: HfApi, repo_id: str, local: Path | str, repo_path: str,
         message: str, repo_type: str = "dataset") -> None:
    last: Exception | None = None
    for attempt, delay in enumerate(RETRY_DELAYS_SEC):
        try:
            api.upload_file(
                path_or_fileobj=str(local),
                path_in_repo=repo_path,
                repo_id=repo_id,
                repo_type=repo_type,
                commit_message=message,
            )
            return
        except HfHubHTTPError as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status in RETRY_STATUS_CODES:
                last = e
                print(f"[hf_push] HF {status} on {repo_path}; retry in {delay}s "
                      f"(attempt {attempt+1}/{len(RETRY_DELAYS_SEC)})",
                      file=sys.stderr)
                time.sleep(delay)
                continue
            raise
    if last is not None:
        raise last
