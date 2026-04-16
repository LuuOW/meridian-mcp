---
name: firecrawl-extract
description: Firecrawl extraction specialist — scrape known URLs into clean markdown, map sites, crawl documentation and blog surfaces, and normalize content capture for downstream reasoning or indexing
---

# firecrawl-extract

Use this when URLs are known and the agent needs clean content, crawl expansion, or sitemap-style discovery.

## Best Uses

- scrape a known page into markdown
- crawl a docs site or blog section
- map a domain into candidate URLs
- normalize extracted content for summarization, chunking, or indexing

## Required Env

- `FIRECRAWL_API_KEY`

## Core Modes

- scrape: one known URL -> markdown and metadata
- map: domain -> candidate URLs
- crawl: seed URL -> bounded URL set and content

## Scrape Pattern

```python
import os
import httpx

FIRECRAWL_API_KEY = os.environ["FIRECRAWL_API_KEY"]

async def firecrawl_scrape(url: str) -> dict:
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            "https://api.firecrawl.dev/v1/scrape",
            headers={
                "Authorization": f"Bearer {FIRECRAWL_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "url": url,
                "formats": ["markdown"],
            },
        )
        resp.raise_for_status()
        return resp.json()
```

## Extraction Rules

- Prefer markdown output over raw HTML for reasoning tasks.
- Keep page metadata with the extracted body.
- Strip obvious nav and boilerplate if the provider did not already do it.
- Bound crawls by path prefix and page count before execution.

## Avoid

- broad topic discovery when the problem is still "what sources matter"
- anti-bot or heavily dynamic targets that need browser-grade collection
- search-engine result capture

## Hand-off Rules

- Accept URLs from `exa-search`.
- Escalate failed dynamic pages to `brightdata-collection`.
- Return normalized content objects suitable for RAG, summarization, or citation analysis.
