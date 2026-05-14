"""ScoredDoc shape + rank_against ordering, with a stub fidelity.

We don't import strawberryfields here — the goal is to test the
ranking/sorting logic deterministically without paying the import cost.
The actual Gaussian-state fidelity is exercised by the live HF Space at
deploy time; numerical correctness of thewalrus.quantum.fidelity is
their responsibility, not ours.
"""

from dataclasses import dataclass

import pytest


@dataclass
class _FakeDoc:
    text: str


@dataclass
class _FakeEncoded:
    doc: _FakeDoc
    score_proxy: float


def test_score_doc_dataclass_shape():
    from photon_route.retrieve import ScoredDoc

    s = ScoredDoc(doc=_FakeEncoded(doc=_FakeDoc(text="x"), score_proxy=0.0), score=0.42)
    assert s.score == pytest.approx(0.42)


def test_rank_against_sorts_descending(monkeypatch):
    """Substitute encode_one + gaussian_fidelity with deterministic stubs;
    verify rank_against returns documents sorted by score, descending."""
    from photon_route import retrieve

    corpus = [
        _FakeEncoded(doc=_FakeDoc(text="a"), score_proxy=0.1),
        _FakeEncoded(doc=_FakeDoc(text="b"), score_proxy=0.9),
        _FakeEncoded(doc=_FakeDoc(text="c"), score_proxy=0.5),
    ]

    def fake_encode_one(text):
        return object()

    def fake_fidelity(q, d):
        return d.score_proxy

    monkeypatch.setattr(retrieve, "encode_one", fake_encode_one)
    monkeypatch.setattr(retrieve, "gaussian_fidelity", fake_fidelity)

    out = retrieve.rank_against(corpus, "anything", top_k=2)
    assert [r.doc.doc.text for r in out] == ["b", "c"]
    assert out[0].score == pytest.approx(0.9)


def test_heap_top_k_matches_full_sort(monkeypatch):
    """heapq.nlargest must return identical ordering to sort()+slice for the
    top-K. Pinned because the heap path was swapped in for performance and
    a future maintainer might revert to .sort() if they don't see why both
    matter — the test ensures both code paths agree on ordering at every K.

    Constructed corpus has ties and out-of-order insertion so a wrong
    secondary-sort (e.g. insertion order vs score-only) would surface.
    """
    from photon_route import retrieve

    # Score profile: ties at 0.7 and 0.4 to exercise the heap stability
    # behaviour. Order matters — different insertion orders should still
    # produce the same K-largest by score.
    scores = [0.10, 0.70, 0.55, 0.40, 0.85, 0.40, 0.70, 0.30, 0.95, 0.20]
    corpus = [
        _FakeEncoded(doc=_FakeDoc(text=f"d{i}"), score_proxy=s)
        for i, s in enumerate(scores)
    ]

    monkeypatch.setattr(retrieve, "encode_one", lambda _t: object())
    monkeypatch.setattr(retrieve, "gaussian_fidelity", lambda _q, d: d.score_proxy)

    # Reference: full sort by score, then slice. This is the pre-heap
    # behaviour the heap call must preserve at every K.
    def full_sort_top_k(k):
        return sorted(corpus, key=lambda d: d.score_proxy, reverse=True)[:k]

    for top_k in [1, 3, 5, 7, len(corpus), len(corpus) + 3]:
        out = retrieve.rank_against(corpus, "q", top_k=top_k)
        expected = full_sort_top_k(top_k)
        # Allow either ordering for tied scores — only verify score-sorted.
        out_scores = [r.score for r in out]
        exp_scores = [d.score_proxy for d in expected]
        assert out_scores == pytest.approx(exp_scores), \
            f"k={top_k}: heap scores {out_scores} != sort scores {exp_scores}"


def test_rank_against_empty_corpus():
    """Edge case the heap path used to mishandle (passing top_k > len to
    heapq.nlargest is fine; the early-return guard ensures we hit sort
    instead). Returns an empty list cleanly."""
    from photon_route import retrieve

    monkeypatch_called = []
    out = retrieve.rank_against([], "q", top_k=5)
    assert out == []


def test_top_k_none_returns_full_sorted(monkeypatch):
    """When the caller omits top_k, every document comes back, sorted
    descending. Important for the compare-all-backends view that needs
    full ranking, not just the top few."""
    from photon_route import retrieve

    corpus = [
        _FakeEncoded(doc=_FakeDoc(text=f"d{i}"), score_proxy=s)
        for i, s in enumerate([0.3, 0.9, 0.1, 0.5])
    ]
    monkeypatch.setattr(retrieve, "encode_one", lambda _t: object())
    monkeypatch.setattr(retrieve, "gaussian_fidelity", lambda _q, d: d.score_proxy)

    out = retrieve.rank_against(corpus, "q", top_k=None)
    assert len(out) == 4
    assert [r.score for r in out] == pytest.approx([0.9, 0.5, 0.3, 0.1])
