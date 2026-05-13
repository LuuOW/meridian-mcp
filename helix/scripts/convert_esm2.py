#!/usr/bin/env python3
"""One-shot: convert facebook/esm2_t30_150M_UR50D → ONNX + int8 and push
to luuow/esm2-150M-onnx so the protein slot in mcp/_lib/models.mjs
becomes a real load instead of a stub.

Usage:
    pip install "optimum[onnxruntime]" huggingface_hub
    HF_TOKEN=$(security find-generic-password -s huggingface-token -w) \\
        python helix/scripts/convert_esm2.py

Runtime: ~3-5 min on M-series CPU (~2 GB RAM). Outputs an ~80 MB int8
ONNX. Once uploaded, edit mcp/_lib/models.mjs and remove `stub: true`
from the protein slot.

Why int8 not int4: ONNX Runtime's standard quantization is INT8 dynamic.
Int4 (MatMul-only weight packing) is supported in newer Optimum but the
quality drop on ESM-2 embeddings isn't well-characterized; INT8 gives
predictable behavior at ~80 MB which still fits the browser budget.
"""
from __future__ import annotations

import os
import sys
import shutil
from pathlib import Path

MODEL_ID  = "facebook/esm2_t30_150M_UR50D"
TARGET    = "luuow/esm2-150M-onnx"
WORK      = Path("./esm2-150M-onnx-build")


def main() -> int:
    if "HF_TOKEN" not in os.environ:
        print("HF_TOKEN required", file=sys.stderr)
        return 1

    try:
        from optimum.onnxruntime import ORTModelForMaskedLM, ORTQuantizer
        from optimum.onnxruntime.configuration import AutoQuantizationConfig
        from transformers import AutoTokenizer
        from huggingface_hub import HfApi
    except ImportError as e:
        print(f"missing dep: {e}\nrun: pip install 'optimum[onnxruntime]' huggingface_hub",
              file=sys.stderr)
        return 1

    WORK.mkdir(exist_ok=True)
    print(f"[1/4] export ONNX from {MODEL_ID}")
    model = ORTModelForMaskedLM.from_pretrained(MODEL_ID, export=True)
    tok   = AutoTokenizer.from_pretrained(MODEL_ID)
    onnx_dir = WORK / "fp32"
    model.save_pretrained(onnx_dir)
    tok.save_pretrained(onnx_dir)

    print("[2/4] quantize → int8 dynamic")
    quantizer = ORTQuantizer.from_pretrained(onnx_dir)
    qconfig   = AutoQuantizationConfig.avx2(is_static=False)  # broadest browser support
    q_dir = WORK / "int8"
    quantizer.quantize(save_dir=q_dir, quantization_config=qconfig)

    print(f"[3/4] artifacts at {q_dir}:")
    for p in sorted(q_dir.iterdir()):
        sz = p.stat().st_size / 1024**2
        print(f"  {p.name:40} {sz:7.1f} MB")

    print(f"[4/4] push → {TARGET}")
    api = HfApi(token=os.environ["HF_TOKEN"])
    api.create_repo(TARGET, repo_type="model", exist_ok=True, private=False)
    api.upload_folder(folder_path=str(q_dir), repo_id=TARGET, repo_type="model",
                      commit_message="esm2-150M int8 ONNX (avx2 dynamic)")
    print(f"\ndone. Next: edit mcp/_lib/models.mjs, remove `stub: true` from")
    print(f"the protein slot and bump version → 'esm2-150M/int8@1'.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
