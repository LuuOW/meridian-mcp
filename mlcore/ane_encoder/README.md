# mlcore/ane_encoder

A small encoder-only transformer, written in the **Apple Neural Engine idiom
from day one**, converted to a CoreML MLPackage, and verified to land **100%
on the Apple Neural Engine at runtime** — confirmed programmatically via
`MLComputePlan`, not just Xcode GUI inspection.

This is the **template** for the strategic target: replacing the LLM-side
"score therapeutic protein candidates" hop in helix with an on-device
ESM2 encoder. Get the recipe right here on a 20 MB demo, then apply the
same recipe to ESM2-150M (`helix/scripts/convert_esm2.py`).

## Headline numbers

At `ANE_PRESET=realistic` (default, ~10M params, 20 MB FP16):

| Proof | Verdict | What it shows |
|---|---|---|
| **Static op-allowlist** | **100.0%** | 625/625 ops in the MIL spec are on the ANE-eligible allowlist (parsed from the .mlpackage MIL). |
| **Runtime compute plan** | **100.0%** | 217/217 schedulable ops have `preferred = NeuralEngine` according to `MLComputePlan.load(...)`. Zero CPU, zero GPU. This is the same data the Xcode Performance Report shows, queried without Xcode. |
| **Numeric parity** | **PASS** | 0 of 24,576 elements exceed combined FP16 tolerance. Max abs delta: 1.6e-2 vs PyTorch FP32 baseline. |
| **Latency** | informational | Python's `predict()` IPC overhead obscures absolute speedup on tiny models; runtime plan is the load-bearing proof. |

Reproduce: `make verify`.

Proof artefacts land in `build/proof/`:
- `residency.txt` — every op in the MIL spec + verdict
- `runtime_plan.json` — `MLComputePlan` per-op device assignment
- `parity.txt`     — PyTorch vs CoreML output, max abs delta
- `latency.txt`    — CPU_ONLY vs CPU_AND_NE wall-time
- `proof.md`       — consolidated report

## Two presets — and why you should care about both

```bash
make verify              # realistic (default): 100% runtime ANE
make tiny                # tiny preset: proves recipe but CPU-preferred
```

| Preset | Size | Static eligibility | Runtime placement |
|---|---|---|---|
| `tiny` (2L × 128 × 4 heads, ~800 KB) | 217 ops, 77 schedulable | 100% on ANE allowlist | **0% — scheduler picks CPU** |
| `realistic` (6L × 384 × 6 heads, ~20 MB) | 625 ops, 217 schedulable | 100% on ANE allowlist | **100% on ANE** |

**This is the most important finding from the build.** Every op in the `tiny`
preset is *eligible* for ANE — `MLComputePlan` confirms ANE is in `.supported`
for all 77 schedulable ops. But the runtime scheduler chooses CPU as
`.preferred` for all of them anyway, because the model is too small to
amortise ANE dispatch cost on Mac.

You only get the **placement** benefit at non-toy scale. The recipe is
correct at any size; the scheduler chooses ANE once the compute-per-op
exceeds the dispatch overhead, around 5-10M params on Apple Silicon.

If you only check static eligibility, you'd ship a model that satisfies all
four constraints and *still runs on CPU at runtime* because you missed the
scale threshold. This module catches that.

## The four constraints — how this module satisfies each

| Constraint | What it means | This module |
|---|---|---|
| **Precision** | FP16 weights + activations end to end | `compute_precision=ct.precision.FLOAT16` in `convert.py`. PyTorch model traced in fp32, weights converted at export. |
| **Layout** | `(B, C, 1, S)` 4-D, matmuls as `1×1 Conv2d` | All linear layers in `ane_modules.py` are `nn.Conv2d(in, out, 1)`. Attention Q/K/V/Out projections are Conv2d. Layout entered at the embedding boundary, never left. |
| **Operators** | ANE allowlist: split-axis LayerNorm, tanh-GELU, no `concat`/`bmm`/`einsum`/`scaled_dot_product_attention` | `LayerNormANE` channels-dim-1. `nn.GELU(approximate='tanh')`. Multi-head attention rewritten as Conv2d projections + element-wise mul + reduce_sum. Verified: zero `concat`, zero `bmm`, zero `einsum`. |
| **Shapes** | Static at conversion time (or RangeDim) | Batch is fixed at 1, dim at 384, dummy axis at 1, sequence is `ct.RangeDim(32, 256, default=64)`. |

## Programmatic ANE inspection — the Swift bit

`inspect_ane.swift` uses Apple's `MLComputePlan` API (macOS 14.4+ / iOS 17.4+)
to query the runtime compute-unit plan **without going through the Xcode GUI**.
It produces the same per-op device-assignment data the Xcode Performance Report
shows, as a JSON file the CI can consume.

```bash
xcrun coremlcompiler compile build/AneEncoder.mlpackage build/
swift inspect_ane.swift build/AneEncoder.mlmodelc
# → build/proof/runtime_plan.json
```

`make verify` runs this automatically.

## Usage

```bash
make venv      # one-time: create .venv and install coremltools + torch
make verify    # convert + compile + run all four proofs
```

Re-run with a different preset:
```bash
make tiny      # tiny preset (fast iteration; CPU-preferred at runtime)
```

## Apply this to ESM2-150M

`helix/scripts/convert_esm2.py` currently emits int8 ONNX for in-browser use.
To target ANE instead:

1. Replace the HF model class with one built from `ane_modules.py`
   primitives (attention/FFN/LayerNorm).
2. Load upstream weights into the rewritten module. ESM2 dim=640, 30
   layers, 20 heads — all Conv2d-shaped after the rewrite.
3. Trace and convert with `convert.py` (set `ANE_PRESET=esm2-150m` or
   inline DIM=640, N_LAYERS=30, N_HEADS=20; raise `SEQ_MAX` to 1024).
4. `make verify`.

Expected first-pass residency: ≥95% static, ≥95% runtime. Two
reshape/transpose fixes typically take it to 99%+. The remaining ≤1% is
the I/O boundary transpose, eliminable only if the caller (an iOS helix
wrapper) allocates the input `MLMultiArray` directly in
`(1, 640, 1, S)` layout.

## What is NOT 100% — be honest

`MLComputePlan` returns `nil` for `const` ops and structural ops (block
boundaries). These don't have a "compute unit" assignment because they
aren't scheduled at runtime — constants are baked into ANE-resident memory
at load time, and structural ops are just graph metadata. We report
"100% of schedulable ops on ANE" rather than "100% of all ops on ANE" to
make this distinction explicit. The Xcode Performance Report makes the
same distinction (constants aren't listed in its compute-unit table).
