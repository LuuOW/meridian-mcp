---
name: exa-search
description: Exa search specialist — semantic web discovery, source ranking, entity finding, citation set building, and lightweight content retrieval for evidence-driven agent workflows
keywords: ["exa", "search", "specialist", "semantic", "web", "discovery", "source", "ranking", "entity", "finding", "citation", "set", "building", "lightweight", "content"]
orb_class: moon
---

# exa-search

Use this when the task begins with discovery rather than known URLs.

## Best Uses

- find authoritative sources for a topic
- discover entities, people, companies, products, or docs pages
- build candidate citation sets before extraction
- rank likely-useful pages for downstream summarization

## Required Env

- `EXA_API_KEY`

## Output Priorities

Return a compact evidence set:

- title
- url
- snippet
- reason selected
- confidence

Do not fetch full page content unless the task explicitly needs it or the runtime has a lightweight Exa contents endpoint wired.

## Query Patterns

```python
import os
import httpx

EXA_API_KEY = os.environ["EXA_API_KEY"]

async def exa_search(query: str, num_results: int = 5) -> dict:
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            "https://api.exa.ai/search",
            headers={
                "x-api-key": EXA_API_KEY,
                "Content-Type": "application/json",
            },
            json={
                "query": query,
                "numResults": num_results,
                "useAutoprompt": True,
                "type": "auto",
            },
        )
        resp.raise_for_status()
        return resp.json()
```

## Selection Heuristics

Prefer sources that are:

- primary or official when the task is factual
- recent when the task is temporal
- direct documentation when the task is technical
- high-signal niche sources over generic SEO pages

## Avoid

- deep extraction work when URLs are already known
- hostile surfaces that need rendering or proxying
- SERP capture tasks

## Hand-off Rules

- Pass chosen URLs to `firecrawl-extract` for content capture.
- Escalate to `brightdata-collection` only if discovery must happen on a blocked or geo-specific surface.
