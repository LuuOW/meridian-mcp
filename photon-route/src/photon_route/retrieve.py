"""Retrieval = Gaussian-state fidelity.

Both query and document are encoded as Gaussian states (mean vector mu,
covariance matrix V). The score is the fidelity F(rho_q, rho_d), which
for two Gaussian states has a closed form (Banchi-Braunstein-Pirandola
2015) implemented in `thewalrus.quantum.fidelity`.

The fidelity is symmetric and lies in [0, 1]; F = 1 iff the two states
are identical.

Pure linear-algebra computation, runs on CPU in milliseconds for the
day-1 fixture. The point isn't speed — it's whether the *geometry* of
CV photonic state space gives different rankings than DV qubit overlap
or classical dense embeddings, and on what kinds of input that
difference matters.
"""

from __future__ import annotations

import heapq
from dataclasses import dataclass

from photon_route.encode import EncodedDoc, encode_one


@dataclass
class ScoredDoc:
    """A retrieval result. `score` is Gaussian fidelity in [0, 1]."""

    doc: EncodedDoc
    score: float


def gaussian_fidelity(state_a, state_b) -> float:
    """Fidelity between two SF GaussianState objects.

    Uses thewalrus.quantum.fidelity, which expects
    (mu_a, cov_a, mu_b, cov_b) in the standard SF/thewalrus convention
    (hbar=2, quadrature ordering: [x_1, x_2, ..., p_1, p_2, ...]).
    """
    from thewalrus.quantum import fidelity as tw_fidelity

    mu_a = state_a.means()
    cov_a = state_a.cov()
    mu_b = state_b.means()
    cov_b = state_b.cov()
    f = tw_fidelity(mu_a, cov_a, mu_b, cov_b)
    return float(max(0.0, min(1.0, f.real if hasattr(f, "real") else f)))


def rank_against(
    corpus: list[EncodedDoc],
    query: str,
    top_k: int | None = None,
) -> list[ScoredDoc]:
    """Encode query, score every document, return the top-K (or all) sorted descending.

    When the caller wants only the top-K, we use a heap-based partial sort
    (`heapq.nlargest`) which is O(N log K) instead of the full O(N log N)
    sort. For N=88 day-1 docs and K=5 this is academic, but it keeps the
    cost proportional to K rather than N as the corpus grows.
    """
    q_state = encode_one(query)
    scored: list[ScoredDoc] = []
    for d in corpus:
        try:
            s = gaussian_fidelity(q_state, d.state)
        except (ValueError, RuntimeError):
            s = 0.0
        scored.append(ScoredDoc(doc=d, score=s))
    if top_k is not None and top_k < len(scored):
        return heapq.nlargest(top_k, scored, key=lambda x: x.score)
    scored.sort(key=lambda x: x.score, reverse=True)
    return scored
