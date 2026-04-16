---
name: persona-research
description: Public persona research authority — discover, rank, and curate public sources for a person across websites, YouTube, podcasts, newsletters, LinkedIn, and social profiles while avoiding name collisions, wrong-identity contamination, and low-signal pages
keywords: ["persona", "research", "public", "youtube", "linkedin", "authority", "discover", "rank", "curate", "sources", "person", "websites", "podcasts", "newsletters", "social"]
orb_class: trojan
---

# persona-research

Use this when the task is to build a source base for a person-specific profile, partner agent, or high-fidelity voice model from public material.

## Use It For

- Finding the right person across ambiguous search results
- Expanding from an official site into high-signal internal pages
- Ranking public sources by usefulness for persona modeling
- Separating self-authored material from reviews, testimonials, and commentary

## Workflow

1. Start with seeded facts:
   - official website
   - known YouTube/channel URLs
   - LinkedIn/X/Instagram/newsletter/podcast URLs
   - domain keywords and exclude keywords

2. Discover candidate sources:
   - search the person name alone
   - search the person name with domain-specific terms
   - search the official domain for bio, about, newsletter, podcast, articles, services
   - search YouTube watch pages, not just channel pages

3. Score and keep sources in this priority order:
   - official bio/about pages
   - self-authored newsletters and articles
   - direct video/podcast episode pages with transcript potential
   - self-authored landing pages describing methods, products, or worldview
   - secondary profiles like LinkedIn

4. De-prioritize or exclude:
   - wrong-person matches
   - generic channel pages
   - widget-heavy social embeds
   - testimonials and student/customer quotes
   - pages dominated by site chrome rather than authored text

## Source Quality Heuristics

- Prefer first-person language over third-party praise
- Prefer pages with concrete claims, methods, beliefs, and tradeoffs
- Prefer episode pages and transcripts over thumbnails, posts, or playlists
- Prefer stable identity pages for biography and claims
- Prefer public sources that can be cited later

## Identity Collision Handling

When multiple people share the same name:

- add `focus_keywords` tied to the target domain
- add `exclude_keywords` tied to the wrong identity
- boost `preferred_domains`
- require at least one official domain or self-authored page before accepting a new cluster of sources

## Output Shape

Produce a source set with:

- URL
- source type
- whether it appears self-authored
- whether it appears transcript-capable
- why it was kept
- why low-signal candidates were excluded

## Rules

- Treat biography and identity claims as highest-risk; prefer official site or direct profile sources
- Treat testimonials as evidence of offer reception, not identity or worldview
- Treat social/channel pages as discovery aids unless they contain direct authored text or transcripts
