// Composer — turns arxiv metadata into the three artifacts the page needs:
//   * HTML body for the post (header + paper button + lead + banner img + body)
//   * SVG banner
//   * nav-card entry on /blog/index.html
//
// This is intentionally rule-based, no LLM in the loop. The studio UI lets
// the user edit the body in <textarea> before publishing.

import type { ArxivMeta } from "./arxiv"
import { slugifyTitle } from "./arxiv"

const MAX_LEAD = 280

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function splitAbstract(abstract: string): { lead: string; body: string[] } {
  const cleaned = abstract.replace(/\s+/g, " ").trim()
  // First sentence — ends with . ! or ?
  const sentenceEnd = cleaned.search(/[.!?]\s/);
  let lead: string
  let rest: string
  if (sentenceEnd > 0 && sentenceEnd < MAX_LEAD) {
    lead = cleaned.slice(0, sentenceEnd + 1)
    rest = cleaned.slice(sentenceEnd + 1).trim()
  } else {
    // Fallback: hard-truncate at MAX_LEAD
    lead = cleaned.slice(0, MAX_LEAD).trim()
    if (!/[.!?]$/.test(lead)) lead = lead.replace(/\s+\S*$/, "") + "…"
    rest = cleaned.slice(lead.length).trim()
  }
  // Body: split remaining text into 2-paragraph chunks.
  const sentences = rest.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [rest]
  const body: string[] = []
  let buf = ""
  for (const s of sentences) {
    const next = s.trim()
    if (!next) continue
    const candidate = (buf ? buf + " " : "") + next
    if (candidate.length > 600 && buf) {
      body.push(buf.trim())
      buf = next
    } else {
      buf = candidate
    }
  }
  if (buf.trim()) body.push(buf.trim())
  return { lead, body }
}

function metaFromSubject(subject: string): string {
  // "Quantum Physics (quant-ph)" → "quantum physics"
  const m = subject.match(/^(.*?)\s*\(/);
  const cat = (m ? m[1] : subject).trim().toLowerCase()
  return cat
}

function readTimeFromAbstract(abstract: string): number {
  // Naive: 1 minute per 200 words, clamped 4-12.
  const words = abstract.split(/\s+/).length
  const m = Math.max(4, Math.min(12, Math.round(words / 200)))
  return m
}

export interface DraftArtifacts {
  slug: string
  meta_line: string        // e.g. "2026-06-23 · 8 min read · quantum simulation"
  h1: string               // article <h1> (same as arxiv title by default)
  lead: string             // 1-sentence lead
  body_paragraphs: string[] // 2-3 paragraphs derived from the abstract
  banner_svg: string
  index_card: {            // for /blog/index.html
    meta: string
    title: string
    href: string
    description: string
  }
}

export function composeDraft(meta: ArxivMeta): DraftArtifacts {
  const slug = slugifyTitle(meta.title, meta.arxiv_id)
  const today = new Date().toISOString().slice(0, 10)
  const minutes = readTimeFromAbstract(meta.abstract)
  const subject = metaFromSubject(meta.primary_subject)
  const meta_line = `${today} · ${minutes} min read · ${subject}`
  const { lead, body } = splitAbstract(meta.abstract)
  const banner_svg = bannerForSlug(slug, meta.title)
  const index_description = `A technical briefing on arXiv:${meta.arxiv_id}: ${lead}`

  return {
    slug,
    meta_line,
    h1: meta.title,
    lead,
    body_paragraphs: body.length ? body : [meta.abstract],
    banner_svg,
    index_card: {
      meta: meta_line,
      title: meta.title,
      href: `/blog/${slug}/`,
      description: index_description,
    },
  }
}

// Minimal banner SVG matching the rest of the blog's dark technical style.
// The user can edit / regenerate this in the studio before publishing.
export function bannerForSlug(slug: string, title: string): string {
  const words = title.split(/\s+/).slice(0, 6)
  const headline1 = words.slice(0, Math.ceil(words.length / 2)).join(" ").toUpperCase()
  const headline2 = words.slice(Math.ceil(words.length / 2)).join(" ").toUpperCase()
  const safe = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080">
  <defs>
    <radialGradient id="spaceGradient" cx="50%" cy="50%" r="75%">
      <stop offset="0%" stop-color="#0a1625" />
      <stop offset="60%" stop-color="#050c16" />
      <stop offset="100%" stop-color="#02050a" />
    </radialGradient>
    <linearGradient id="goldText" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#f3e9dc" />
      <stop offset="60%" stop-color="#dfc29e" />
      <stop offset="100%" stop-color="#b89773" />
    </linearGradient>
    <pattern id="dotPattern" width="40" height="40" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1" fill="#58a6ff" fill-opacity="0.15"/>
    </pattern>
  </defs>
  <rect width="1920" height="1080" fill="url(#spaceGradient)"/>
  <rect width="1920" height="1080" fill="url(#dotPattern)"/>
  <rect x="30" y="30" width="1860" height="1020" rx="10" fill="none" stroke="#ffffff" stroke-width="1" opacity="0.08"/>
  <g transform="translate(960, 220)" text-anchor="middle" font-family="Arial, sans-serif">
    <g transform="translate(0, -90)">
      <rect x="-140" y="-18" width="280" height="32" rx="16" fill="#ffffff" fill-opacity="0.04" stroke="#ffffff" stroke-opacity="0.15" stroke-width="1"/>
      <circle cx="-110" cy="-2" r="3" fill="#38bdf8"/>
      <text y="4" font-size="13" font-weight="bold" fill="#a0afb7" letter-spacing="4">ARXIV BRIEFING</text>
    </g>
    <text font-size="56" font-weight="800" fill="#ffffff" letter-spacing="5">${safe(headline1)}</text>
    <text y="85" font-size="56" font-weight="800" fill="url(#goldText)" letter-spacing="5">${safe(headline2)}</text>
    <text y="170" font-size="20" font-weight="500" fill="#a0afb7" letter-spacing="3" opacity="0.8">EDIT ME &middot; arXiv:${slug.split("-")[0]}</text>
  </g>
  <g stroke="#38bdf8" stroke-width="2" fill="none" opacity="0.5">
    <path d="M 50,50 L 150,50 M 50,50 L 50,150"/>
    <path d="M 1870,50 L 1770,50 M 1870,50 L 1870,150"/>
    <path d="M 50,1030 L 150,1030 M 50,1030 L 50,930"/>
    <path d="M 1870,1030 L 1770,1030 M 1870,1030 L 1870,930"/>
  </g>
  <g transform="translate(960, 1010)" text-anchor="middle" font-family="sans-serif">
    <text font-size="15" font-weight="bold" fill="#ffffff" fill-opacity="0.4" letter-spacing="4">— ASK-MERIDIAN.UK —</text>
    <text y="24" font-size="13" fill="#718096" fill-opacity="0.8" letter-spacing="1">/blog/${slug}/</text>
  </g>
</svg>
`
}

// Build the full HTML page. Body is composed of `<p>` blocks from the abstract.
// The studio UI lets the user override the body before publishing.
export function renderPostHtml(opts: {
  meta_line: string
  h1: string
  lead: string
  body_paragraphs: string[]
  banner_svg_path: string   // "/img/blog/<slug>-banner.svg"
  banner_alt: string
  arxiv_id: string
  paper_url: string
  slug: string
  custom_body?: string       // optional override from the studio UI
}): string {
  const body = opts.custom_body ?? opts.body_paragraphs.map(p => `      <p>${p}</p>`).join("\n")
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${htmlEscape(opts.h1)} &mdash; Meridian Blog</title>
<meta name="description" content="${htmlEscape(opts.lead)}">
<meta property="og:title" content="${htmlEscape(opts.h1)}">
<meta property="og:type" content="article">
<meta property="og:url" content="https://ask-meridian.uk/blog/${opts.slug}/">
<meta property="og:image" content="https://ask-meridian.uk${opts.banner_svg_path}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://ask-meridian.uk${opts.banner_svg_path}">
<link rel="canonical" href="https://ask-meridian.uk/blog/${opts.slug}/">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/style.css?v=20260527a">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" crossorigin="anonymous">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js" crossorigin="anonymous"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js" crossorigin="anonymous" onload="renderMathInElement(document.body, {delimiters: [{left: '$$', right: '$$', display: true}, {left: '$', right: '$', display: false}, {left: '\\\\(', right: '\\\\)', display: false}, {left: '\\\\[', right: '\\\\]', display: true}], throwOnError: false});"></script>
</head>
<body>
  <main id="main" style="padding-top: 48px;">
    <article class="article-body">
      <header style="margin-top: 64px; margin-bottom: 32px;">
        <div class="article-meta">${htmlEscape(opts.meta_line)}</div>
        <h1 style="font-size: 36px; line-height: 1.15; margin: 8px 0 16px;">${htmlEscape(opts.h1)}</h1>
        <p class="lead" style="font-size: 18px; color: var(--text-muted); line-height: 1.5; margin: 0 0 16px;">
          ${htmlEscape(opts.lead)}
        </p>
        <a href="${htmlEscape(opts.paper_url)}" class="btn-arxiv" target="_blank" rel="noopener">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 2px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></polyline><polyline points="10 9 9 9 8 9"></polyline></svg>
          Paper: arXiv:${htmlEscape(opts.arxiv_id)}
        </a>
      </header>
      <img src="${htmlEscape(opts.banner_svg_path)}" alt="${htmlEscape(opts.banner_alt)}" style="width: 100%; height: auto; display: block; border-radius: 14px; margin: 32px 0 28px; border: 1px solid var(--border);">
${body}
      <p class="article-meta">Reference: arXiv:${htmlEscape(opts.arxiv_id)} &middot; ${htmlEscape(opts.h1)}</p>
    </article>
  </main>
<script type="module" src="/blog/listen.js"></script>
</body>
</html>
`
}
