---
name: seo
description: SEO authority — SERP analysis, GEO/AEO citation patterns, E-E-A-T signals, keyword research, technical SEO audits, structured data, and content-to-ranking pipeline patterns for AI-assisted publishing workflows
---

# seo

Authoritative reference for search engine optimisation across traditional SERP, Generative Engine Optimisation (GEO), and Answer Engine Optimisation (AEO). Covers research, technical audits, and the full content-to-ranking pipeline.

## 1) Keyword research pipeline

```python
# Seed → cluster → prioritise
def keyword_pipeline(seed: str, domain: str) -> list[dict]:
    # 1. Expand seed via SERP "People Also Ask" + autocomplete
    # 2. Cluster by semantic similarity (embeddings or manual)
    # 3. Score each cluster: volume × (1 - difficulty) × relevance
    pass

# Scoring formula
def priority_score(volume: int, difficulty: float, relevance: float) -> float:
    return volume * (1 - difficulty) * relevance

# Target: difficulty < 0.40, relevance > 0.70, volume > 500/mo
```

## 2) GEO — Generative Engine Optimisation

GEO targets AI-generated answers (ChatGPT, Perplexity, Gemini) rather than blue links.

```markdown
# GEO citation requirements (per article)
- Cite 3+ primary sources (academic, government, or high-DA publications)
- Include a structured "Key Takeaways" section at H2 level
- Add FAQ schema with 5+ Q&A pairs that mirror natural language queries
- Use direct answer format: lead with the answer, then explain
- Entity density: 2-4 named entities per 200 words
- Include a data table or comparison table — AI engines frequently quote tables
```

```python
# Detect citation gaps vs. top-3 SERP competitors
async def find_citation_gaps(slug: str, domain: str) -> list[str]:
    competitor_urls = await get_top3_serp(slug)
    their_citations = await extract_citations(competitor_urls)
    our_citations   = await extract_citations([f"/{slug}"])
    return [c for c in their_citations if c not in our_citations]
```

## 3) AEO — Answer Engine Optimisation

```markdown
# AEO structural requirements
- H1 must contain the primary keyword verbatim
- First paragraph answers the query in ≤ 50 words (featured snippet target)
- Use question-format H2s: "What is X?", "How does X work?"
- Structured data: Article + FAQPage + BreadcrumbList schemas
- Reading level: Flesch-Kincaid grade 8-10 (accessible to AI parsers)
```

```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [{
    "@type": "Question",
    "name": "What is the keto diet?",
    "acceptedAnswer": {
      "@type": "Answer",
      "text": "The ketogenic diet is a high-fat, low-carbohydrate eating plan..."
    }
  }]
}
```

## 4) E-E-A-T signals

```markdown
# Experience, Expertise, Authoritativeness, Trustworthiness
- Author bio with credentials on every article
- "Last reviewed" date visible above the fold
- Cite primary research: PubMed, government (.gov), university (.edu) sources
- External links to authoritative sources (2-5 per article, opens in new tab)
- Internal links: 3-5 per article to related cluster content
- Word count: 1500-3000 for informational; 800-1200 for transactional
```

## 5) Technical SEO checklist

```bash
# Core Web Vitals targets
LCP  < 2.5s    # Largest Contentful Paint
FID  < 100ms   # First Input Delay  
CLS  < 0.1     # Cumulative Layout Shift
TTFB < 800ms   # Time to First Byte

# Crawlability
- robots.txt: disallow /admin, /api, /staging
- sitemap.xml: auto-generated, submitted to GSC
- Canonical tags on all paginated/duplicate URLs
- hreflang for multilingual content
- 301 redirect chains: max 1 hop

# On-page
- Title tag: 50-60 chars, keyword first
- Meta description: 150-160 chars, call to action
- H1: one per page, matches title intent
- Image alt text: descriptive, keyword-relevant
- URL slug: lowercase, hyphens, keyword, max 5 words
```

## 6) SERP delta monitoring

```python
# Track rank changes over time
async def serp_delta(domain: str, keywords: list[str]) -> list[dict]:
    deltas = []
    for kw in keywords:
        current_rank = await get_current_rank(domain, kw)
        previous_rank = await get_stored_rank(domain, kw)
        delta = previous_rank - current_rank  # positive = improved
        if abs(delta) >= 3:
            deltas.append({"keyword": kw, "delta": delta, "current": current_rank})
    return sorted(deltas, key=lambda x: abs(x["delta"]), reverse=True)

# Alert on significant drops
RANK_DROP_THRESHOLD = -5  # alert if rank drops 5+ positions
```

## 7) Content cluster architecture

```
# Hub-and-spoke model
/keto-diet/                          ← Pillar page (2500+ words)
  /keto-diet/beginners-guide/        ← Spoke (1500 words)
  /keto-diet/food-list/              ← Spoke (data-rich table content)
  /keto-diet/meal-plan/              ← Spoke (transactional)
  /keto-diet/side-effects/           ← Spoke (E-E-A-T heavy)

# Internal linking rule: every spoke links to pillar + 2 sibling spokes
# Pillar links to all spokes
```

## 8) Publishing pipeline integration

```python
# seo-geo-aeo-engine agent sequence
# E1: Research (SERP + citations)
# E2: Outline (cluster-aware structure)
# E3: Draft (E-E-A-T compliant)
# E4: SERP delta check (post-publish monitoring)
# E5: Link score (internal/external link health)
# E6: Publish (Supabase → Astro SSR)
# E7: GEO refresh (citation gap re-write, not new article)

async def should_refresh(slug: str) -> bool:
    """Refresh existing article if citation gap found, don't create duplicate."""
    gaps = await find_citation_gaps(slug, domain)
    rank = await get_current_rank(domain, slug)
    return len(gaps) >= 2 or rank > 20
```

## 9) Checklist — before publishing

- [ ] Primary keyword in H1, title tag, first 100 words, and URL
- [ ] FAQPage schema with 5+ Q&A pairs
- [ ] 3+ citation-worthy sources linked (primary research)
- [ ] Featured snippet paragraph: ≤ 50 words, direct answer
- [ ] Internal links: 3-5 to cluster siblings and pillar
- [ ] Author bio + credentials + last-reviewed date
- [ ] Meta description written (150-160 chars, CTR-optimised)
- [ ] Images have descriptive alt text
- [ ] Canonical tag set correctly
- [ ] Submitted to sitemap / GSC after publish
