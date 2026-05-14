"""
Tiny encoder-only transformer assembled from ane_modules.py primitives.

Shape config tuned to converge quickly during conversion (~seconds) while
exercising every transformer primitive end to end. Scaling to ESM2-150M
is a matter of bumping DIM/N_LAYERS/N_HEADS; the architectural shape
(everything in (B, C, 1, S), Conv2d 1×1 matmuls, ANE LayerNorm,
tanh-GELU, no concat) stays identical.
"""
from __future__ import annotations

import torch
import torch.nn as nn

from ane_modules import EncoderBlockANE, LayerNormANE


# --- Architecture config ---------------------------------------------------
# Two presets. Both satisfy the four constraints identically — the only
# difference is parameter count, which controls whether the runtime
# scheduler chooses ANE vs CPU at placement time.
#
#   ANE_PRESET=tiny       — 2L × 128 × 4 heads (~200 KB). Converts in <1 s.
#                           Proves the recipe. CPU-preferred at runtime
#                           because the model is too small to amortise
#                           ANE dispatch cost.
#
#   ANE_PRESET=realistic  — 6L × 384 × 6 heads (~10M params, ~20 MB FP16).
#                           ESM2-class. ANE-preferred at runtime.
import os

PRESET = os.environ.get("ANE_PRESET", "realistic").lower()

if PRESET == "tiny":
    DIM, N_LAYERS, N_HEADS, FFN_MULT = 128, 2, 4, 4
elif PRESET == "realistic":
    DIM, N_LAYERS, N_HEADS, FFN_MULT = 384, 6, 6, 4
else:
    raise ValueError(f"unknown ANE_PRESET={PRESET!r} (use 'tiny' or 'realistic')")

# Sequence length: a default for tracing. The actual model accepts any
# length in [SEQ_MIN, SEQ_MAX] thanks to ct.RangeDim at conversion time.
SEQ_DEFAULT = 64
SEQ_MIN     = 32
SEQ_MAX     = 256


class AneTinyEncoder(nn.Module):
    """Encoder that consumes a (1, DIM, 1, S) fp16-clean tensor.

    Input contract is intentionally NOT (B, S, C). The caller is expected
    to feed pre-transposed data. This eliminates the entry-side transpose
    that otherwise costs a few % residency at the I/O boundary.

    For a typical sequence-encoding use case the caller would:
        embed:   (B, S) ints -> (B, S, C) floats     [external, e.g. tokeniser + embedding]
        permute: (B, S, C) -> (B, C, S) -> unsqueeze -> (B, C, 1, S)
    and consume the output in the same layout.
    """
    def __init__(self,
                 dim: int = DIM,
                 n_layers: int = N_LAYERS,
                 n_heads: int = N_HEADS,
                 ffn_mult: int = FFN_MULT):
        super().__init__()
        self.dim = dim
        self.blocks = nn.ModuleList([
            EncoderBlockANE(dim, n_heads, ffn_mult) for _ in range(n_layers)
        ])
        self.ln_f = LayerNormANE(dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (B, C, 1, S), float
        for blk in self.blocks:
            x = blk(x)
        x = self.ln_f(x)
        return x


def build_traceable_model(seed: int = 0) -> tuple[AneTinyEncoder, torch.Tensor]:
    """Build the model + a representative example tensor for tracing.

    Deterministic init so the parity test produces reproducible numbers.
    """
    torch.manual_seed(seed)
    model = AneTinyEncoder()
    model.eval()
    example = torch.randn(1, DIM, 1, SEQ_DEFAULT)
    return model, example
