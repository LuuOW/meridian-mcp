"""Per-stage gate JSON — N inputs / N outputs / pass-fail snapshot.

Each stage calls write_gate() once at end of main(). The dashboard reads
gates/{stage}_{perihelion}.json to surface pass/fail pills without log
diving. Errors during writing the gate must never crash the stage —
gates are observability, not correctness.

Schema (versioned by `schema_version`):
  schema_version: 1
  stage: short ID ("pull" / "register" / "detect" / "coincide" / "calibrate" / "forecast")
  perihelion: "E20" etc
  ok: bool — gate-level pass/fail (see thresholds below)
  n_inputs: int — what came in (samples, files, events, etc.)
  n_outputs: int — what went out
  notes: optional dict of extras (e.g. n_failed_probes, mean_match_score)
  started: ISO timestamp
  ended: ISO timestamp
  duration_sec: float
  reason: str — short human-readable summary
"""
from __future__ import annotations

import json
import sys
import time
import traceback
from pathlib import Path

import pandas as pd
from huggingface_hub import HfApi

GATE_SCHEMA_VERSION = 1


class Gate:
    """Context manager that times a stage and writes its gate JSON on exit.

    Usage:
        with Gate("detect", perihelion="E20", repo_id="...", api=api) as g:
            ...
            g.n_inputs = 9_887_661   # PSP samples
            g.n_outputs = 413        # PSP events
            g.notes["n_probes_with_events"] = 4
            # ok = True by default; set g.ok = False / g.reason = "..."
            # on early-exit cases the gate still writes (best-effort).
    """

    def __init__(self, stage: str, perihelion: str, repo_id: str,
                 api: HfApi | None = None, local_cache: Path | None = None):
        self.stage = stage
        self.perihelion = perihelion
        self.repo_id = repo_id
        self.api = api
        self.local_cache = local_cache or Path("helio_cache/gates")
        self.local_cache.mkdir(parents=True, exist_ok=True)
        self.n_inputs: int | None = None
        self.n_outputs: int | None = None
        self.ok: bool = True
        self.reason: str = "ok"
        self.notes: dict = {}
        self._started: float = 0.0

    def __enter__(self):
        self._started = time.time()
        self._started_iso = pd.Timestamp.utcnow().isoformat()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> bool:
        ended = time.time()
        if exc_type is not None:
            self.ok = False
            self.reason = f"{exc_type.__name__}: {str(exc_val)[:160]}"
        gate = {
            "schema_version": GATE_SCHEMA_VERSION,
            "stage": self.stage,
            "perihelion": self.perihelion,
            "ok": bool(self.ok),
            "n_inputs": self.n_inputs,
            "n_outputs": self.n_outputs,
            "notes": self.notes,
            "started": self._started_iso,
            "ended": pd.Timestamp.utcnow().isoformat(),
            "duration_sec": round(ended - self._started, 2),
            "reason": self.reason,
        }
        try:
            out = self.local_cache / f"{self.stage}_{self.perihelion}.json"
            out.write_text(json.dumps(gate, indent=2, default=str))
            if self.api is not None:
                from hf_push import push as _push
                _push(self.api, self.repo_id, out,
                      f"gates/{self.stage}_{self.perihelion}.json",
                      f"gate: {self.stage} {self.perihelion} "
                      f"{'ok' if self.ok else 'FAIL'} "
                      f"({self.n_inputs}→{self.n_outputs})")
            print(f"[gate/{self.stage}] {'ok' if self.ok else 'FAIL'} "
                  f"in {gate['duration_sec']}s — {self.reason}")
        except Exception as e:
            # Gate-write failure must never poison the stage outcome.
            print(f"[gate/{self.stage}] gate write failed: {e}", file=sys.stderr)
            traceback.print_exc()
        # Do NOT swallow the original exception — return False so the stage's
        # actual error still propagates.
        return False
