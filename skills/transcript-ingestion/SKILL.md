---
name: transcript-ingestion
description: Transcript ingestion authority — capture, normalize, and prioritize transcripts from YouTube videos, podcast pages, captions, show notes, and transcript-like page content for persona systems, RAG pipelines, and grounded synthesis
---

# transcript-ingestion

Use this when the task depends on spoken-source fidelity: YouTube episodes, podcast interviews, show transcripts, or transcript-like notes.

## Goal

Turn noisy video or podcast pages into transcript-grade text that is usable for retrieval and persona synthesis.

## Preferred Order

1. Native captions/transcript endpoints for video pages
2. Transcript text exposed in page HTML or markdown
3. Show notes with transcript-like conversational blocks
4. Cleaned descriptive page text only as fallback

## Workflow

1. Classify the source:
   - `video_page`
   - `youtube_channel`
   - `podcast_page`
   - `podcast_landing`
   - generic `web`

2. For `video_page`:
   - fetch page HTML
   - extract player response metadata
   - locate caption tracks
   - prefer English human captions, then English auto-captions
   - parse `json3` or XML transcript payloads

3. For podcast or transcript-like pages:
   - search for headings like `Transcript`, `Episode transcript`, `Show transcript`, `Show notes`
   - capture timestamped lines
   - strip timestamps only after preserving ordering

4. Normalize:
   - remove UI chrome
   - remove timestamps when compiling plain text
   - collapse whitespace
   - preserve speaker turns when available

## Keep

- opening thesis
- repeated mental models
- self-descriptions
- practical advice
- tradeoffs and caveats
- examples and stories that reveal operating style

## Remove

- player controls
- likes/views/share chrome
- subscription prompts
- embed/widget boilerplate
- unrelated recommendations

## Weighting Rules

- transcript text should outrank generic page text
- direct episode transcripts should outrank channel pages
- self-authored or self-spoken material should outrank testimonials
- short fragments like `Watch full video` are not transcripts

## Validation

A transcript pass is acceptable when:

- it contains coherent clauses, not just labels
- it materially improves over page summary text
- it is tied to a specific episode or identifiable source

Mark transcript ingestion quality clearly:

- `direct_captions`
- `page_transcript`
- `show_notes_fallback`
- `no_transcript`
