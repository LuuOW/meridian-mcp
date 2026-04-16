---
name: content
description: Content strategy authority — editorial calendar, content briefs, topic clustering, AI-assisted writing workflows, UGC patterns, publishing pipelines, and brand voice guidelines across blog, social, and email formats
---

# content

Covers the full content lifecycle: strategy, briefing, production (AI-assisted and human), and distribution. Applies across blog, email, UGC, and social formats.

## 1) Content brief template

```markdown
# Brief: [Article Title]

**Target keyword**: [primary keyword]
**Search intent**: informational | transactional | navigational | commercial
**Word count**: [target range]
**Funnel stage**: TOFU | MOFU | BOFU

## Audience
- Who: [persona]
- Pain point: [specific problem this solves]
- Prior knowledge: beginner | intermediate | expert

## Structure
- H1: [exact title]
- H2s: [list of sections]
- Featured snippet target: [≤50 word answer to lead with]

## Must-include
- [ ] Cite: [source 1], [source 2], [source 3]
- [ ] Data point: [statistic or study]
- [ ] CTA: [specific action at end]

## Tone
[brand voice adjectives — e.g., "authoritative but approachable, no jargon"]
```

## 2) Topic clustering (programmatic)

```python
from sklearn.metrics.pairwise import cosine_similarity
import numpy as np

def cluster_topics(keywords: list[str], embeddings: np.ndarray, threshold: float = 0.82) -> list[list[str]]:
    """Group semantically similar keywords into content clusters."""
    sim_matrix = cosine_similarity(embeddings)
    clusters, assigned = [], set()
    for i, kw in enumerate(keywords):
        if i in assigned:
            continue
        cluster = [kw]
        assigned.add(i)
        for j in range(i + 1, len(keywords)):
            if j not in assigned and sim_matrix[i][j] >= threshold:
                cluster.append(keywords[j])
                assigned.add(j)
        clusters.append(cluster)
    return sorted(clusters, key=len, reverse=True)
```

## 3) AI-assisted writing workflow

```python
# Multi-pass writing: research → outline → draft → refine
async def write_article(brief: dict) -> str:
    # Pass 1: Research context
    research = await gather_research(brief["keyword"], brief["citations"])

    # Pass 2: Outline (structure-first)
    outline = await llm_call(
        system="You are a senior editor. Output only a structured markdown outline.",
        prompt=f"Create outline for: {brief['title']}\nResearch context:\n{research[:2000]}"
    )

    # Pass 3: Draft section by section (prevents context overflow)
    sections = []
    for section in parse_outline(outline):
        draft = await llm_call(
            system=brief["tone_instructions"],
            prompt=f"Write section: {section}\nBrief: {brief}\nPrior sections summary: {summarise(sections)}"
        )
        sections.append(draft)

    # Pass 4: Editorial polish
    full_draft = "\n\n".join(sections)
    return await llm_call(
        system="Fix grammar, improve flow, ensure E-E-A-T compliance. Do not change facts.",
        prompt=full_draft
    )
```

## 4) Brand voice guidelines (reference format)

```markdown
# Voice: [Brand Name]

## Tone adjectives
authoritative, practical, direct — never preachy or jargon-heavy

## Sentence structure
- Prefer active voice
- Max sentence length: 25 words
- Use second person ("you") for instructional content
- Avoid: "leverage", "utilize", "synergy", "holistic"

## Formatting rules
- Lead with the answer (inverted pyramid)
- Use bullet lists for 3+ items
- Bold only the most critical term per paragraph
- No Oxford serial comma in short lists (use it in lists of 4+)

## Examples of on-brand vs off-brand
✓ "Add 2 tbsp of MCT oil to your morning coffee."
✗ "Consider incorporating MCT oil supplementation into your ketogenic protocol."
```

## 5) Editorial calendar schema

```python
CONTENT_ITEM = {
    "slug":         str,    # URL slug
    "title":        str,
    "keyword":      str,
    "cluster":      str,    # parent cluster/pillar
    "funnel_stage": str,    # TOFU | MOFU | BOFU
    "format":       str,    # article | email | social | ugc
    "status":       str,    # brief | draft | review | published
    "publish_date": str,    # ISO date
    "author":       str,    # human | ai-assisted | ai
    "word_count":   int,
    "assigned_to":  str,    # agent slug or human name
}

# Publishing cadence targets
CADENCE = {
    "blog":   3,   # articles per week
    "email":  1,   # newsletters per week
    "social": 5,   # posts per week
}
```

## 6) UGC content patterns

```python
# User-Generated Content acquisition prompts
UGC_PROMPTS = {
    "review":       "Share your [timeframe] results with [product]. What surprised you most?",
    "before_after": "Show us your transformation. Before photo + what changed after [action].",
    "tip":          "What's your single best tip for [goal]? Keep it to 1-2 sentences.",
    "objection":    "What was your biggest doubt before starting [product/approach]? How wrong were you?",
}

# UGC curation criteria
def score_ugc(submission: dict) -> float:
    score = 0.0
    if submission.get("photo"):            score += 0.30
    if len(submission["text"]) > 50:       score += 0.20
    if submission.get("specific_result"):  score += 0.30
    if submission.get("timeframe"):        score += 0.20
    return score  # > 0.60 = publish-worthy
```

## 7) Content repurposing matrix

```
Article (2000w)
├── Email digest (300w summary → newsletter)
├── 5x social posts (1 stat/insight each)
├── Short-form video script (60s hook + 3 points)
├── FAQ additions (extract Q&A pairs → schema)
└── Lead magnet (expand BOFU section → PDF checklist)
```

## 8) Content performance metrics

```python
CONTENT_KPIs = {
    "organic_traffic":    "GA4 sessions from organic search",
    "avg_time_on_page":   "> 90s target",
    "scroll_depth":       "> 60% target",
    "conversion_rate":    "email signup or purchase / sessions",
    "serp_rank":          "target: top 10 for primary keyword within 90 days",
    "backlinks_earned":   "target: 1+ referring domain per article within 6 months",
}

# Alert thresholds
ALERTS = {
    "rank_drop":        5,     # positions
    "traffic_drop_pct": 20,    # week-over-week
    "bounce_rate":      0.85,  # above this = content mismatch
}
```

## 9) Checklist — content production

- [ ] Brief complete with keyword, intent, audience, citations
- [ ] Outline approved before full draft
- [ ] Draft passes E-E-A-T checklist (author, citations, date)
- [ ] Reading level checked (Flesch-Kincaid 8-10)
- [ ] CTA present and matches funnel stage
- [ ] Repurposing assets created (social snippets, email summary)
- [ ] Published with correct schema markup
- [ ] Added to editorial calendar with publish date
- [ ] SERP tracking enabled post-publish
