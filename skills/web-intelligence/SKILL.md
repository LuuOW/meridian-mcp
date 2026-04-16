---
name: web-intelligence
description: Web intelligence routing authority — choose Exa for discovery, Firecrawl for extraction and crawling, and Bright Data for dynamic or geo-sensitive collection; normalize outputs, costs, and fallback policy for agentic research workflows
---

# web-intelligence

Use this when the agent needs external web evidence and the question is not satisfied by one generic browser fetch.

## Goal

Route web work to the right provider with a stable contract:

- `exa-search` for discovery, ranking, and source finding
- `firecrawl-extract` for clean content extraction, crawl expansion, sitemap mapping, and markdown capture
- `brightdata-collection` for hostile, dynamic, geo-sensitive, or SERP-specific collection

## Routing Rules

1. Start with `exa-search` when the task begins with a question, entity, or topic rather than known URLs.
2. Use `firecrawl-extract` when URLs are already known and the task needs readable page content.
3. Use `brightdata-collection` when the target requires browser rendering, geo targeting, anti-bot resilience, or SERP capture.
4. Prefer a staged pipeline over direct heavy collection:
   - discovery via Exa
   - extraction via Firecrawl
   - hard-target recovery via Bright Data
5. Use Bright Data sparingly. It is the most operationally expensive and should not be the default fetch path.

## Normalized Output Contract

Return provider results in this shape whenever practical:

```json
{
  "query": "string",
  "goal": "source_discovery|page_extraction|site_crawl|serp_capture",
  "items": [
    {
      "title": "string",
      "url": "string",
      "snippet": "string",
      "content_markdown": "string",
      "source_provider": "exa|firecrawl|brightdata",
      "retrieved_at": "ISO-8601",
      "confidence": 0.0
    }
  ],
  "notes": ["string"]
}
```

## Decision Table

| Task shape | Preferred provider | Reason |
| --- | --- | --- |
| Find best sources on a topic | Exa | semantic search and ranking |
| Extract article text from known URL | Firecrawl | clean markdown and crawl tools |
| Crawl a docs site or sitemap | Firecrawl | purpose-built crawl/map endpoints |
| Capture Google results in a country | Bright Data | browser and geo collection |
| Extract blocked JS-heavy page | Bright Data | rendering and anti-bot resilience |
| Fill citation gaps from discovered URLs | Exa then Firecrawl | separate finding from extraction |

## Cost Discipline

- Exa is the default for source discovery.
- Firecrawl is the default for page content once URLs are known.
- Bright Data requires an explicit reason in the work log: `dynamic target`, `geo-sensitive target`, `bot protection`, or `SERP capture`.

## Failure Policy

- If Exa returns weak or sparse sources, widen query terms once, then switch to Bright Data only if the surface itself is the problem.
- If Firecrawl fails on one URL, retry once. If the page is JS-driven or blocked, escalate to Bright Data.
- If Bright Data is used, save the exact target and reason so the pattern can be reused later.

## Invocation Examples

- "Find primary sources on payroll software for contractors" -> `exa-search`
- "Extract the content of these five URLs" -> `firecrawl-extract`
- "Capture UK mobile SERP for this keyword" -> `brightdata-collection`
- "Research competitor claims and quote evidence" -> `exa-search`, then `firecrawl-extract`
