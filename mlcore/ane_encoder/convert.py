"""
PyTorch → MLPackage conversion.

Knobs that matter for ANE residency, all set explicitly here so it's
audit-able from one file:

  - compute_precision    = FLOAT16          (constraint 1)
  - compute_units        = CPU_AND_NE       (forces scheduler choice)
  - target               = iOS18            (stateful + latest op support)
  - input shape          = (1, DIM, 1, RangeDim(SEQ_MIN..SEQ_MAX))
                                            (constraint 2 layout + 4 shapes)
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import torch

import coremltools as ct

from model import AneTinyEncoder, DIM, SEQ_DEFAULT, SEQ_MIN, SEQ_MAX, build_traceable_model


BUILD_DIR = Path(__file__).parent / "build"
MLPACKAGE = BUILD_DIR / "AneEncoder.mlpackage"
META_JSON = BUILD_DIR / "build_meta.json"


def main() -> int:
    BUILD_DIR.mkdir(parents=True, exist_ok=True)

    if MLPACKAGE.exists():
        print(f"[clean] removing stale {MLPACKAGE.name}")
        shutil.rmtree(MLPACKAGE)

    print("[1/4] build + trace PyTorch model")
    model, example = build_traceable_model(seed=0)
    with torch.no_grad():
        traced = torch.jit.trace(model, example)

    print("[2/4] convert to CoreML MLPackage")
    t0 = time.time()
    mlmodel = ct.convert(
        traced,
        convert_to="mlprogram",
        compute_precision=ct.precision.FLOAT16,
        compute_units=ct.ComputeUnit.CPU_AND_NE,
        minimum_deployment_target=ct.target.iOS18,
        inputs=[ct.TensorType(
            name="x",
            shape=(1, DIM, 1, ct.RangeDim(lower_bound=SEQ_MIN,
                                          upper_bound=SEQ_MAX,
                                          default=SEQ_DEFAULT)),
            dtype=np.float16,
        )],
        outputs=[ct.TensorType(name="y", dtype=np.float16)],
    )
    convert_s = time.time() - t0
    print(f"       converted in {convert_s:.1f}s")

    print("[3/4] annotate + save MLPackage")
    mlmodel.author       = "Meridian / mlcore.ane_encoder"
    mlmodel.short_description = (
        "Tiny encoder-only transformer written in the Apple Neural Engine "
        "idiom (Conv2d-as-matmul, (B,C,1,S), split-axis LayerNorm, "
        "tanh-GELU, no concat). Reference implementation for the "
        "ESM2-150M port."
    )
    mlmodel.version      = "0.1.0"
    mlmodel.save(str(MLPACKAGE))

    print("[4/4] write build_meta.json")
    meta = {
        "package_path":      str(MLPACKAGE.relative_to(BUILD_DIR.parent)),
        "convert_seconds":   round(convert_s, 2),
        "coremltools":       ct.__version__,
        "torch":             torch.__version__,
        "compute_units":     "CPU_AND_NE",
        "compute_precision": "FLOAT16",
        "min_target":        "iOS18",
        "input_shape":       [1, DIM, 1, f"RangeDim({SEQ_MIN}..{SEQ_MAX}, default={SEQ_DEFAULT})"],
        "model_dim":         DIM,
        "model_seq_default": SEQ_DEFAULT,
    }
    META_JSON.write_text(json.dumps(meta, indent=2))

    pkg_size = sum(p.stat().st_size for p in MLPACKAGE.rglob("*") if p.is_file())
    print(f"\nOK. MLPackage at {MLPACKAGE.relative_to(BUILD_DIR.parent.parent)} "
          f"({pkg_size/1024:.1f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
