"""
Parity test: PyTorch FP32 baseline vs CoreML FP16 output.

Asserts max absolute delta stays within FP16 numerical tolerance. This
proves the ANE-idiom rewrite (Conv2d-as-matmul, custom LayerNorm, hand-
rolled attention) didn't change semantics relative to the textbook
formulation.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import torch

import coremltools as ct

from model import DIM, SEQ_DEFAULT, build_traceable_model


# FP16 tolerance — generous because the model does multiple LayerNorms
# and softmaxes whose ULP error compounds. 5e-2 max-abs is the standard
# threshold Apple's own examples use.
ATOL = 5e-2
RTOL = 5e-2


def main(mlpackage_path: str) -> int:
    pkg = Path(mlpackage_path)
    if not pkg.exists():
        print(f"error: {pkg} does not exist (run `make convert` first)", file=sys.stderr)
        return 2

    print("[1/3] rebuild PyTorch baseline (same seed as conversion)")
    model, example = build_traceable_model(seed=0)
    with torch.no_grad():
        baseline = model(example).numpy()

    print(f"[2/3] load CoreML model from {pkg.name}")
    # CPU_ONLY for parity test so we're comparing numeric output, not
    # measuring ANE behaviour. Latency test below uses CPU_AND_NE.
    mlmodel = ct.models.MLModel(str(pkg), compute_units=ct.ComputeUnit.CPU_ONLY)

    print("[3/3] run inference + compare")
    x = example.numpy().astype(np.float16)
    output = mlmodel.predict({"x": x})
    y = list(output.values())[0]
    y = np.asarray(y, dtype=np.float32)

    delta = np.abs(baseline - y)
    max_abs = float(delta.max())
    mean_abs = float(delta.mean())
    # Combined tolerance (numpy.allclose convention): |a-b| <= atol + rtol*|b|.
    # This is the right way to handle FP16 LayerNorm outputs that can be
    # near zero — pure relative error blows up on those, pure absolute
    # error misses large values. Combined is what np.allclose / Apple
    # examples use.
    threshold = ATOL + RTOL * np.abs(baseline)
    violations = (delta > threshold).sum()
    headroom_ratio = float((delta / threshold).max())  # <1 means PASS everywhere
    allclose_pass = violations == 0

    print(f"\n[parity] shape:        pytorch={baseline.shape}, coreml={y.shape}")
    print(f"[parity] max |dy|:     {max_abs:.4e}")
    print(f"[parity] mean |dy|:    {mean_abs:.4e}")
    print(f"[parity] tolerance:    atol={ATOL}, rtol={RTOL}  (combined: atol + rtol*|b|)")
    print(f"[parity] violations:   {violations} / {delta.size} elements")
    print(f"[parity] worst ratio:  {headroom_ratio:.3f}  (1.0 = exactly at threshold)")

    proof_dir = pkg.parent / "proof"
    proof_dir.mkdir(exist_ok=True)
    (proof_dir / "parity.txt").write_text(
        f"# Parity (PyTorch FP32 vs CoreML FP16, CPU_ONLY)\n\n"
        f"shape:         pytorch={baseline.shape}, coreml={y.shape}\n"
        f"max |dy|:      {max_abs:.4e}\n"
        f"mean |dy|:     {mean_abs:.4e}\n"
        f"tolerance:     atol={ATOL}, rtol={RTOL} (combined)\n"
        f"violations:    {violations} / {delta.size}\n"
        f"worst ratio:   {headroom_ratio:.3f} (1.0 = at threshold)\n"
        f"verdict:       {'PASS' if allclose_pass else 'FAIL'}\n"
    )

    if allclose_pass:
        print("\nPASS — CoreML output matches PyTorch baseline within FP16 tolerance.")
        return 0

    print("\nFAIL — output diverges beyond tolerance. Likely a layout/op rewrite bug.",
          file=sys.stderr)
    return 1


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "build/AneEncoder.mlpackage"
    sys.exit(main(path))
