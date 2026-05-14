"""
PyTorch primitives in the Apple Neural Engine idiom.

Every module here obeys the four constraint families:
  1. Precision  — fp16-clean: no float-only ops, nothing that forces fp32.
  2. Layout     — tensors are (B, C, 1, S). Linear ops are Conv2d 1×1.
  3. Operators  — only ops on the ANE allowlist (no torch.bmm, no einsum,
                  no concat, no scaled_dot_product_attention).
  4. Shapes     — every dim known at trace time except S (handled at
                  conversion via ct.RangeDim).

These are minimal hand-written replacements modelled on
apple/ml-ane-transformers. Kept inline (no extra dep) so the module is
self-contained and reviewable in one file.
"""
from __future__ import annotations

import math

import torch
import torch.nn as nn


class LayerNormANE(nn.Module):
    """LayerNorm over the channel axis of a (B, C, 1, S) tensor.

    Stock nn.LayerNorm assumes the last dim is the normalised axis. In
    ANE layout the normalised axis is dim 1 (channels), not dim -1. We
    compute mean/var along dim 1 explicitly, then apply per-channel
    affine. This is the form Apple's compiler keeps on the ANE.
    """
    def __init__(self, num_channels: int, eps: float = 1e-5):
        super().__init__()
        self.eps = eps
        # weight/bias are broadcastable to (1, C, 1, 1)
        self.weight = nn.Parameter(torch.ones(1, num_channels, 1, 1))
        self.bias   = nn.Parameter(torch.zeros(1, num_channels, 1, 1))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (B, C, 1, S)
        mean = x.mean(dim=1, keepdim=True)
        var  = x.var(dim=1, keepdim=True, unbiased=False)
        x = (x - mean) * torch.rsqrt(var + self.eps)
        return x * self.weight + self.bias


class MultiHeadAttentionANE(nn.Module):
    """Multi-head self-attention rewritten as Conv2d projections + a
    Conv2d-shaped batch matmul. No torch.bmm, no einsum, no
    scaled_dot_product_attention — those route off the ANE allowlist.
    """
    def __init__(self, dim: int, n_heads: int):
        super().__init__()
        assert dim % n_heads == 0
        self.dim     = dim
        self.n_heads = n_heads
        self.d_head  = dim // n_heads
        self.scale   = 1.0 / math.sqrt(self.d_head)

        # Q/K/V/Out projections are 1×1 Conv2d over (B, C, 1, S).
        # bias kept (matches HF transformer convention).
        self.q_proj   = nn.Conv2d(dim, dim, 1)
        self.k_proj   = nn.Conv2d(dim, dim, 1)
        self.v_proj   = nn.Conv2d(dim, dim, 1)
        self.out_proj = nn.Conv2d(dim, dim, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (B, C, 1, S)
        B, C, _, S = x.shape
        H, D = self.n_heads, self.d_head

        q = self.q_proj(x)   # (B, C, 1, S)
        k = self.k_proj(x)
        v = self.v_proj(x)

        # Split heads while STAYING in 4D. Reshape (not transpose) keeps
        # the ANE compiler happy. Result: (B*H, D, 1, S).
        q = q.reshape(B * H, D, 1, S)
        k = k.reshape(B * H, D, 1, S)
        v = v.reshape(B * H, D, 1, S)

        # attention scores: (B*H, S, S). Computed via element-wise
        # multiply + sum across head-dim, which is the ANE-friendly
        # form of a batched matmul Q^T K. q is (B*H, D, 1, S) -> we
        # treat the S axis of q as queries and S axis of k as keys.
        # Implementation: reshape q to (B*H, D, S, 1), k to (B*H, D, 1, S),
        # multiply -> (B*H, D, S, S), sum over D -> (B*H, 1, S, S).
        q4 = q.permute(0, 1, 3, 2)                     # (B*H, D, S, 1)
        scores = (q4 * k).sum(dim=1, keepdim=True)     # (B*H, 1, S, S)
        scores = scores * self.scale
        attn = torch.softmax(scores, dim=-1)           # softmax over keys

        # Apply attention to v. v is (B*H, D, 1, S). For each query s
        # we want sum_t attn[s,t] * v[:,t]. Implementation:
        #   attn:   (B*H, 1, S_q, S_k)
        #   v:      (B*H, D, 1,   S_k)
        # multiply -> (B*H, D, S_q, S_k), sum over S_k -> (B*H, D, S_q, 1)
        # then permute to (B*H, D, 1, S_q).
        out = (attn * v).sum(dim=-1, keepdim=True)     # (B*H, D, S, 1)
        out = out.permute(0, 1, 3, 2)                  # (B*H, D, 1, S)

        # Merge heads back. Reshape (B*H, D, 1, S) -> (B, C, 1, S).
        out = out.reshape(B, C, 1, S)
        return self.out_proj(out)


class FFNAne(nn.Module):
    """Feed-forward block as Conv2d 1×1 + tanh-GELU + Conv2d 1×1.

    Exact GELU falls off the ANE allowlist. The tanh approximation is
    the form Apple's compiler keeps on-engine.
    """
    def __init__(self, dim: int, ffn_mult: int = 4):
        super().__init__()
        self.fc1 = nn.Conv2d(dim, dim * ffn_mult, 1)
        self.act = nn.GELU(approximate='tanh')
        self.fc2 = nn.Conv2d(dim * ffn_mult, dim, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.fc2(self.act(self.fc1(x)))


class EncoderBlockANE(nn.Module):
    """One transformer encoder block: LN → MHA → resid → LN → FFN → resid.

    Residual is element-wise add (ANE-eligible). LayerNorm is on the
    channel axis of the (B, C, 1, S) tensor.
    """
    def __init__(self, dim: int, n_heads: int, ffn_mult: int = 4):
        super().__init__()
        self.ln1  = LayerNormANE(dim)
        self.attn = MultiHeadAttentionANE(dim, n_heads)
        self.ln2  = LayerNormANE(dim)
        self.ffn  = FFNAne(dim, ffn_mult)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.attn(self.ln1(x))
        x = x + self.ffn(self.ln2(x))
        return x
