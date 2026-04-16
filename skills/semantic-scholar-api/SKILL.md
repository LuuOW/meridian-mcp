---
name: semantic-scholar-api
description: Semantic Scholar + OpenAlex citation graph APIs for walking paper-to-paper relationships, finding citers/references, author disambiguation, and discovering related work. Use when arxiv or keyword search is insufficient — e.g. "what papers cite this one", "who else works on X", "what's the precursor work behind this abstract". Both APIs are free; no key required for reasonable usage.
---

# semantic-scholar-api

## When to invoke
- User has a seed paper and wants its citation neighborhood
- Building a recommender that extends past keyword match
- Author disambiguation (two people with same name)
- Finding "influential" papers in a topic (citation-weighted)
- Getting canonical abstract/DOI when arXiv's metadata is incomplete

## Two complementary APIs

| API | Strength | Rate limit (no key) |
|---|---|---|
| **Semantic Scholar** `api.semanticscholar.org/graph/v1/` | Rich citation graph, influence scoring, AI-extracted tldr | 1 req/sec |
| **OpenAlex** `api.openalex.org/` | Larger coverage (250M+ works), institution + funding data | 10 req/sec with email in User-Agent |

Use **S2** for depth (citations, references, influence), **OpenAlex** for breadth (coverage, metadata richness).

## Semantic Scholar — core endpoints

```
GET /graph/v1/paper/{id}
GET /graph/v1/paper/{id}/citations    # who cites this paper
GET /graph/v1/paper/{id}/references   # what this paper cites
GET /graph/v1/paper/search?query=...
GET /graph/v1/author/{id}/papers
```

### Paper ID formats S2 accepts
- arXiv: `arXiv:2604.13012` or `ARXIV:2604.13012`
- DOI: `10.1038/s41586-023-06792-0`
- PubMed: `PMID:34567890`
- CorpusId: `CorpusId:12345678`
- S2 SHA: `649def34f8be52c8b66281af98ae884c09aef38b`

### Minimal citation walk

```python
import requests, time
BASE = "https://api.semanticscholar.org/graph/v1"
HEADERS = {"User-Agent": "research-tool/1.0 (contact@example.com)"}

def paper(pid, fields="title,abstract,tldr,year,citationCount,authors"):
    r = requests.get(f"{BASE}/paper/{pid}", params={"fields": fields}, headers=HEADERS, timeout=15)
    r.raise_for_status()
    return r.json()

def citations(pid, limit=20, fields="title,year,citationCount,authors"):
    r = requests.get(
        f"{BASE}/paper/{pid}/citations",
        params={"fields": fields, "limit": limit},
        headers=HEADERS, timeout=15,
    )
    r.raise_for_status()
    return [c["citingPaper"] for c in r.json().get("data", [])]

def references(pid, limit=20, fields="title,year,citationCount"):
    r = requests.get(
        f"{BASE}/paper/{pid}/references",
        params={"fields": fields, "limit": limit},
        headers=HEADERS, timeout=15,
    )
    r.raise_for_status()
    return [c["citedPaper"] for c in r.json().get("data", [])]

# Example: walk 1 hop out from an arxiv paper
seed = paper("arXiv:2604.13032")
print(seed["title"], "→", seed["tldr"])
time.sleep(1)  # rate limit
for citer in citations("arXiv:2604.13032", limit=5):
    print(" cited by:", citer["title"])
```

### Useful response fields

| Field | Purpose |
|---|---|
| `tldr.text` | S2's AI-generated one-sentence summary — free, often excellent |
| `citationCount` | Raw citations |
| `influentialCitationCount` | Citations where this paper "significantly shaped" the citer (better signal than raw) |
| `openAccessPdf.url` | Direct PDF if OA |
| `embedding` | 768-dim SPECTER2 embedding (for semantic search) |
| `authors[].hIndex` | Author stature |

## OpenAlex — complementary queries

```python
BASE_OA = "https://api.openalex.org"
HEADERS_OA = {"User-Agent": "research-tool/1.0 (mailto:you@example.com)"}  # include mailto for polite-pool

def openalex_paper(doi_or_id):
    # DOI: https://api.openalex.org/works/doi:10.1038/...
    # OpenAlex ID: W2741809807
    # arxiv: use search since no direct arxiv lookup
    r = requests.get(f"{BASE_OA}/works/{doi_or_id}", headers=HEADERS_OA, timeout=15)
    r.raise_for_status()
    return r.json()

def openalex_search_by_concept(concept_id, filters=None, per_page=25):
    # concept IDs like "C121332964" (physics)
    params = {"filter": f"concepts.id:{concept_id}", "per_page": per_page}
    if filters: params["filter"] += "," + filters
    r = requests.get(f"{BASE_OA}/works", params=params, headers=HEADERS_OA, timeout=15)
    return r.json().get("results", [])
```

### OpenAlex-only goodies
- **Concepts** — hierarchical topic taxonomy (gives you "what's this paper about" in 5 levels)
- **Institutions** — normalized + ROR-linked
- **Funders** — which grants funded each paper
- **OA status** — `oa_status: gold/bronze/green/closed` per paper
- **Cites** via `cited_by_api_url` — no limit

## Common workflows

### 1. "What are the most influential ancestors of this paper?"
```python
refs = references("arXiv:2604.13032", limit=100)
# Sort by influence
refs.sort(key=lambda p: p.get("citationCount", 0), reverse=True)
top_ancestors = refs[:10]
```

### 2. "What recent papers extend this one?"
```python
citers = citations("arXiv:2604.13032", limit=100)
recent = [p for p in citers if (p.get("year") or 0) >= 2024]
recent.sort(key=lambda p: p.get("citationCount", 0), reverse=True)
```

### 3. "Disambiguate an author with a common name"
```python
# S2 tracks authors with internal IDs; OpenAlex uses ORCID when available
r = requests.get(f"{BASE}/author/search", params={"query": "Smith J", "limit": 10})
candidates = r.json().get("data", [])
# Filter by affiliation or paper count
```

### 4. "Get a clean abstract for a paper with only an arxiv ID"
```python
p = paper("arXiv:2604.13012", fields="title,abstract,tldr")
# p["abstract"] is clean (no LaTeX in most cases)
# p["tldr"]["text"] is the AI 1-liner
```

## Rate-limit discipline

- **S2 without key**: 1 req/sec hard. Burst of 10 → banned for ~1 min.
- **S2 with key** (free, just request at semanticscholar.org/api): 100 req/sec
- **OpenAlex polite pool** (include email in User-Agent or `mailto` param): 10 req/sec
- **OpenAlex without email**: 1 req/sec (throttled as anonymous)

Always retry with exponential backoff on 429/500; cache results locally; persist paper JSON for 30+ days since metadata rarely changes.

## Vs arXiv API

| Task | Best tool |
|---|---|
| "Most recent papers in a category" | arXiv |
| "Papers matching complex keyword query" | arXiv (search_query supports AND/OR/NOT) |
| "What cites this paper" | S2 or OpenAlex |
| "What does this paper cite" | S2 (better metadata than arXiv's embedded references) |
| "Get abstract + DOI + OA link" | S2 or OpenAlex |
| "Author's full publication record" | OpenAlex |
| "Which institutions research topic X" | OpenAlex |
| "Influential papers in topic X" | S2 `influentialCitationCount` |

## Known gotchas

1. **arxiv → S2 lookup fails for brand-new papers.** S2 takes 2–7 days to index new arxiv posts. Fall back to arXiv's own metadata for anything <1 week old.
2. **Abstract contains LaTeX.** Usually clean on S2, but check with `$` scan: `if '$' in abstract: # strip or MathJax render`.
3. **`tldr` is not always populated.** About 60% of papers have it. Use it when available; fall back to your own summarizer.
4. **CorpusId vs. DOI inconsistency.** Prefer DOI when both exist; corpus IDs are stable but not shared with other services.
5. **Citation count inflation from self-cites.** S2 separates `selfCitationCount` (via `contexts.isSelfCited`).
