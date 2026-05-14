"""
Static residency check: parse the MIL spec inside the MLPackage,
enumerate every op, assert each one is in the ANE-eligible allowlist.

The allowlist below is the conservative union of:
  - Apple Core ML Tools docs on ANE-supported ops
  - apple/ml-ane-transformers reference implementation
  - empirical Xcode performance reports on similar models

Ops outside the allowlist are FLAGGED. The script exits non-zero if any
op is not on the allowlist, OR if the residency falls below 100%.

This is a STATIC proof — it shows the model's op graph is fully composed
of ANE-eligible ops. The RUNTIME compute unit assignment is finally
authoritative only via Xcode's performance report; see the closing
instructions printed at the end.
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

import coremltools as ct


# Conservative ANE allowlist for Core ML mlprogram ops.
# Source: Apple Core ML Tools docs + ml-ane-transformers reference.
# A few ops (transpose, slice_by_index) are "boundary" — eligible but
# costlier than core compute ops; we flag them informationally.
ANE_ELIGIBLE = {
    # Element-wise / activation
    "add", "sub", "mul", "real_div",
    "tanh", "sigmoid", "gelu", "softmax",
    "rsqrt", "sqrt", "square",
    # Reductions (along supported axes)
    "reduce_mean", "reduce_sum", "reduce_max", "reduce_min",
    # Layout / shape (boundary)
    "reshape", "expand_dims", "squeeze", "transpose", "permute",
    "slice_by_index", "slice_by_size",
    # Core compute
    "conv", "linear", "matmul",
    "layer_norm", "batch_norm",
    "relu",
    # Constants / IO
    "const", "cast",
    # Misc supported
    "identity",
}

# Ops known to fall off ANE. Flagged hard if present.
ANE_INELIGIBLE = {
    "concat", "concat_v2",
    "scaled_dot_product_attention",
    "einsum", "bmm",
    "where",
    "range_1d",
    "scatter", "gather_nd",
}


def main(mlpackage_path: str) -> int:
    pkg = Path(mlpackage_path)
    if not pkg.exists():
        print(f"error: {pkg} does not exist (run `make convert` first)", file=sys.stderr)
        return 2

    print(f"[load] {pkg.name}")
    spec = ct.utils.load_spec(str(pkg))

    if spec.WhichOneof("Type") != "mlProgram":
        print("error: not an ML Program (mlprogram). Re-convert with convert_to='mlprogram'.",
              file=sys.stderr)
        return 2

    program = spec.mlProgram
    op_counter: Counter[str] = Counter()
    flagged: list[tuple[str, str]] = []   # (function_name, op_type) for non-allowlist ops
    informational: list[tuple[str, str]] = []  # boundary ops worth noting

    for fn_name, fn in program.functions.items():
        for block_name, block in fn.block_specializations.items():
            for op in block.operations:
                op_type = op.type
                op_counter[op_type] += 1
                if op_type in ANE_INELIGIBLE:
                    flagged.append((f"{fn_name}/{block_name}", op_type))
                elif op_type not in ANE_ELIGIBLE:
                    # Unknown ops: treat as flagged (conservative — Apple
                    # may have added them since the allowlist was written,
                    # but the burden of proof is on the model author).
                    flagged.append((f"{fn_name}/{block_name}", op_type))

    total = sum(op_counter.values())
    bad = len(flagged)
    good = total - bad
    pct = (good / total * 100.0) if total else 0.0

    print(f"\n[summary] {total} ops total, {good} ANE-eligible, {bad} flagged")
    print(f"[summary] static ANE residency: {pct:.1f}%")
    print()
    print(f"{'op_type':<28}{'count':>8}{'verdict':>20}")
    print("-" * 56)
    for op_type, count in op_counter.most_common():
        if op_type in ANE_INELIGIBLE:
            verdict = "INELIGIBLE"
        elif op_type in ANE_ELIGIBLE:
            verdict = "ANE-eligible"
        else:
            verdict = "UNKNOWN/flagged"
        print(f"{op_type:<28}{count:>8}{verdict:>20}")

    proof_dir = pkg.parent / "proof"
    proof_dir.mkdir(exist_ok=True)
    report_path = proof_dir / "residency.txt"
    with report_path.open("w") as f:
        f.write(f"# Static ANE residency report — {pkg.name}\n\n")
        f.write(f"Total ops: {total}\nANE-eligible: {good}\nFlagged: {bad}\n")
        f.write(f"Static residency: {pct:.1f}%\n\n")
        f.write("Per-op breakdown:\n")
        for op_type, count in op_counter.most_common():
            if op_type in ANE_INELIGIBLE:
                v = "INELIGIBLE"
            elif op_type in ANE_ELIGIBLE:
                v = "ANE-eligible"
            else:
                v = "UNKNOWN/flagged"
            f.write(f"  {op_type:<28} {count:>5}  {v}\n")
        f.write("\nFlagged ops (first 20):\n")
        for fn, op_type in flagged[:20]:
            f.write(f"  {fn:<40} {op_type}\n")
    print(f"\n[write] {report_path}")

    # Print authoritative-proof instructions regardless of pass/fail
    print()
    print("─" * 60)
    print("AUTHORITATIVE PROOF (Xcode performance report):")
    print(f"  open {pkg}")
    print("  Xcode → right-click model → Open Quickly → Performance Report")
    print("  Connect a device (or use Mac as target on Apple Silicon).")
    print("  The 'Compute Unit' column shows per-op assignment.")
    print("─" * 60)

    if bad:
        print(f"\nFAIL — {bad} ineligible/unknown ops:", file=sys.stderr)
        for fn, op_type in flagged[:10]:
            print(f"  {fn}: {op_type}", file=sys.stderr)
        return 1

    print("\nPASS — 100% of ops are on the ANE-eligible allowlist.")
    return 0


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "build/AneEncoder.mlpackage"
    sys.exit(main(path))
