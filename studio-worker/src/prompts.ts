// Prompts for the LLM-driven editorial pass.
//
// Two prompts:
//  1. BRIEFING_PROMPT — given arxiv metadata, produce a JSON with lead + sections
//     + math + callout + rule + figure_note + meta + banner concept.
//  2. The system prompt describes the Meridian house style so the output matches
//     what we write by hand.

export const SYSTEM_PROMPT = `You write blog briefings for Meridian (ask-meridian.uk), a technical site that re-explains recent arXiv papers in plain, restrained, manufacturing-grade language.

Voice rules:
- Lead with the result, not the paper title.
- Prefer declarative prose. No "in this paper we…" filler.
- Short sections, each with one job. Section headers are descriptive, never hype.
- Math only when it adds explanatory value. Wrap inline math in $...$ and display math in $$...$$.
- Use a real-world framing: "what would change in a lab/manufacturing conversation tomorrow?"
- Avoid hedging phrases: "could potentially", "may suggest", "interesting to note".
- If the result is incremental, frame it as a useful diagnostic or bridge, not a breakthrough.
- Every claim anchored to a number, equation, or specific quote from the abstract. No vague claims.

Output: a single JSON object matching the schema in the user prompt. No prose outside the JSON.`

export interface BriefingJSON {
  meta_line: string                 // e.g. "2026-06-23 · 8 min read · quantum photonics"
  lead: string                      // 1-2 sentences, ≤ 280 chars
  banner_headline: string           // 2-4 words for the gold headline line 2 of the banner
  banner_subtitle: string           // short descriptor, e.g. "KR+ IMPLANTATION · 40 keV · hBN"
  banner_palette: "violet" | "cyan" | "amber" | "mixed"   // drives banner accent colour
  banner_concept: string            // one-line description of the visual metaphor (we don't draw it, but we use it to sanity-check the schematic)
  sections: Array<{
    heading: string                  // "<h2>" text, descriptive, not hype
    paragraphs: string[]             // 1-3 paragraphs of body
    math?: Array<{
      label: string                  // shown as the small uppercase label on the math card
      tex: string                    // KaTeX-compatible LaTeX source, display math
    }>
    bullets?: string[]               // optional unordered list
    callout?: {                     // optional highlight box
      text: string
    }
    rule?: {                         // optional pull-quote / single-line takeaway
      text: string
    }
  }>
  takeaway: {                        // final H2 section, always present
    heading: string                  // usually "Takeaway"
    paragraphs: string[]             // 1-2 paragraphs
    bullets?: string[]               // optional "what to keep in mind"
  }
}

export const USER_PROMPT_TEMPLATE = (meta: {
  arxiv_id: string
  title: string
  authors: string[]
  primary_subject: string
  abstract: string
}): string => `Write a Meridian blog briefing for this paper.

Title: ${meta.title}
Authors: ${meta.authors.join(", ") || "(not listed)"}
Subject: ${meta.primary_subject || "(unknown)"}
arXiv id: ${meta.arxiv_id}

Abstract:
"""
${meta.abstract}
"""

Return ONLY a JSON object with this shape:
{
  "meta_line": "YYYY-MM-DD · <N> min read · <3-word topic>",
  "lead": "<1-2 sentence plain-English statement of the result, max 280 chars>",
  "banner_headline": "<2-4 word gold headline for the banner second line>",
  "banner_subtitle": "<short tag-style subtitle, e.g. 'KR+ IMPLANTATION · 40 keV · hBN'>",
  "banner_palette": "violet|cyan|amber|mixed",
  "banner_concept": "<one-line description of what the banner schematic should evoke>",
  "sections": [
    {
      "heading": "<descriptive H2>",
      "paragraphs": ["<plain English body>", "..."],
      "math": [
        { "label": "<uppercase label>", "tex": "<KaTeX-compatible LaTeX source>" }
      ],
      "bullets": ["<optional unordered list items>"],
      "callout": { "text": "<optional highlight>" },
      "rule": { "text": "<optional pull-quote>" }
    }
  ],
  "takeaway": {
    "heading": "Takeaway",
    "paragraphs": ["<closing thought>"],
    "bullets": ["<optional 2-4 'keep in mind' items>"]
  }
}

Constraints:
- 3 to 5 sections in the array, plus the final takeaway.
- Each section has 1-3 paragraphs.
- 0-2 math blocks total across all sections; only include if the math genuinely helps the reader.
- bullet lists are optional, max 5 items.
- callout and rule are optional, max 1 per section.
- The lead must be a full sentence, no truncation mid-phrase.
- Use the actual date 2026-06-23 in meta_line.
- For "N min read" estimate: assume 200 words/minute, clamp to 4-12.
- Banner palette: 'violet' for fundamental/theoretical, 'cyan' for experimental/applied, 'amber' for materials/devices, 'mixed' if the paper spans theory and experiment.

Return only the JSON. No markdown fences, no prose outside the JSON.`
