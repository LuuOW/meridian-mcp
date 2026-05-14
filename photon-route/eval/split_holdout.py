"""Build a chronological train / val / test holdout split for photon-route's
relevance set.

Why this exists: the live `relevance.json` is six hand-curated multi-positive
queries. `expand_titles.py` adds 20 single-positive title-as-query entries.
Together that's 26 queries, but the trainer (`space/train.py`) and the eval
(`eval/run.py`) both consume them as a single pool. So the train-on-everything
+ test-on-everything cycle silently overfits — the photon-route memory note
captures the symptom exactly:

    "6q×20doc eval too small; train==test gives nDCG 0.747, holdout collapses
     to 0.071"

This script splits the relevance set chronologically by the arXiv year of the
target paper, writing three sibling JSON files:

    relevance_train.json      arXiv year ≤ TRAIN_CUTOFF
    relevance_val.json        TRAIN_CUTOFF < year ≤ VAL_CUTOFF
    relevance_test.json       year > VAL_CUTOFF

A chronological split is meaningful here: photonic ML / quantum NLP
terminology drifted between e.g. 2010 and 2024, so training on older work and
evaluating on newer work captures generalisation, not memorisation.

Workflow:

    # 1. expand the relevance set if you haven't (one-shot, requires net)
    python -m photon_route.eval.expand_titles \
        --out eval/relevance_expanded.json

    # 2. split chronologically (offline, just JSON math)
    python -m photon_route.eval.split_holdout \
        --in  eval/relevance_expanded.json \
        --train-cutoff 2018 --val-cutoff 2020

    # 3. retrain on train + early-stop on val
    python -m space.train \
        --relevance eval/relevance_train.json \
        --val-relevance eval/relevance_val.json \
        --out weights_holdout.npz

    # 4. evaluate ON TEST ONLY — this is the number you report
    python -m eval.run \
        --weights weights_holdout.npz \
        --relevance eval/relevance_test.json

Reusable: the same script works for whatever expanded relevance set you
build next — just feed it in via --in.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

# arXiv IDs come in two formats:
#   pre-2007: math.GT/0512345, hep-th/0501123  → no usable year here
#   2007+:    0701.1234, 1306.5358, 2304.12717 → YYMM prefix, ≥ 2007
ARXIV_NEW_RE = re.compile(r"^(\d{2})(\d{2})\.\d{4,5}$")


def year_of(arxiv_id: str) -> int | None:
    m = ARXIV_NEW_RE.match(arxiv_id.strip())
    if not m:
        return None
    yy = int(m.group(1))
    # IDs starting "07–99" → 2007–2099, "00–06" → 2100–2106 (won't happen).
    # arXiv started this format Apr 2007, so any "00–06" prefix is a typo.
    return 2000 + yy if yy >= 7 else None


def split_query_by_year(q: dict, train_cutoff: int, val_cutoff: int):
    """Return ('train' | 'val' | 'test', q) based on the youngest relevant doc.

    Why youngest, not oldest: a query whose RELEVANT papers reach into 2023
    can't be in the training set if our cutoff is 2018 — we'd be leaking
    future labels into training. Use the youngest year as the date-of-knowledge.
    """
    years = [year_of(rid) for rid in q.get("relevant_ids", [])]
    years = [y for y in years if y is not None]
    if not years:
        # Old-format IDs only → put in train (oldest bucket).
        return "train", q
    y_max = max(years)
    if y_max <= train_cutoff:
        return "train", q
    if y_max <= val_cutoff:
        return "val", q
    return "test", q


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", type=Path,
                    default=Path(__file__).parent / "relevance_expanded.json",
                    help="source relevance file (default: relevance_expanded.json)")
    ap.add_argument("--out-dir", type=Path, default=Path(__file__).parent,
                    help="where to write the three split files")
    ap.add_argument("--train-cutoff", type=int, default=2018,
                    help="queries whose youngest relevant doc is ≤ this year → train")
    ap.add_argument("--val-cutoff", type=int, default=2020,
                    help="train-cutoff < year ≤ this → val; year > this → test")
    args = ap.parse_args()

    if not args.inp.exists():
        print(f"missing {args.inp} — run expand_titles.py first?")
        return 1

    src = json.loads(args.inp.read_text("utf-8"))
    queries = src.get("queries", [])
    buckets = {"train": [], "val": [], "test": []}
    for q in queries:
        bucket, q_keep = split_query_by_year(q, args.train_cutoff, args.val_cutoff)
        buckets[bucket].append(q_keep)

    schema_v = src.get("schema_version", 1)
    base_desc = src.get("description", "Chronological holdout split")
    for name, qs in buckets.items():
        path = args.out_dir / f"relevance_{name}.json"
        path.write_text(json.dumps({
            "schema_version": schema_v,
            "description": f"{base_desc} — {name} split "
                           f"(train≤{args.train_cutoff} < val≤{args.val_cutoff} < test).",
            "queries": qs,
        }, indent=2) + "\n", encoding="utf-8")
        print(f"  {name:<6} {len(qs):3d} queries  →  {path.relative_to(args.out_dir.parent)}")

    print(f"\n[split-holdout] total={len(queries)}  "
          f"train={len(buckets['train'])}  val={len(buckets['val'])}  test={len(buckets['test'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
