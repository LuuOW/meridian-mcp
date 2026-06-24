// Composer — LLM-driven editorial pass + paper-specific banner SVG.
//
// Pipeline:
//   1. arxiv metadata → LLM call → BriefingJSON (sections, math, callouts, banner fields)
//   2. BriefingJSON + slug + arxiv_id → post HTML (KaTeX wired, listen.js wired)
//   3. BriefingJSON (banner_* fields) → SVG banner with the right palette + headline
//
// Falls back to the rule-based composer if the LLM env vars aren't set, so the
// studio still works in local dev without an API key.

import type { ArxivMeta } from "./arxiv"
import { slugifyTitle } from "./arxiv"
import { pickArchetype } from "./banners/archetypes"
import { callLLM, type LLMConfig, LLMSchemaError } from "./llm"
import { SYSTEM_PROMPT, USER_PROMPT_TEMPLATE, type BriefingJSON } from "./prompts"



// ─── Inlined nav block ─────────────────────────────────────────────
// Every published post needs the same nav as /blog/, the docs index, etc.
// Instead of relying on a post-publish sync-nav.py step (fragile), we read
// landing/blog/index.html once per Worker lifetime, extract the <nav>...</nav>
// block, and inject it into wrapPageHtml() output. If the read fails, we
// fall back to no nav and log — sync-nav.py will fill it in on next push.
let _navCache: { html: string; at: number } | null = null
const NAV_TTL_MS = 5 * 60 * 1000   // 5 minutes

async function loadNavBlock(env: { GITHUB_TOKEN?: string; GITHUB_REPO?: string }): Promise<string | null> {
  const now = Date.now()
  if (_navCache && (now - _navCache.at) < NAV_TTL_MS) return _navCache.html
  if (!env.GITHUB_TOKEN || env.GITHUB_TOKEN === "DRY-RUN") return null
  const repo = env.GITHUB_REPO ?? "LuuOW/meridian-mcp"
  const url = `https://api.github.com/repos/${repo}/contents/landing/blog/index.html?ref=main`
  try {
    const res = await fetch(url, {
      headers: {
        "authorization": `Bearer ${env.GITHUB_TOKEN}`,
        "accept": "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    })
    if (!res.ok) return null
    const j = await res.json() as { content?: string }
    if (!j.content) return null
    const html = atob(j.content.replace(/\s+/g, ""))
    const m = html.match(/<nav class="nav" aria-label="Primary">[\s\S]*?<\/nav>/)
    if (!m) return null
    _navCache = { html: m[0], at: now }
    return m[0]
  } catch {
    return null
  }
}

export interface DraftArtifacts {
  slug: string
  meta_line: string
  h1: string
  lead: string
  page_html: string                // full <article>...</article> string (without <html><body>)
  banner_svg: string
  index_card: {
    meta: string
    title: string
    href: string
    description: string
  }
  llm_used: boolean               // diagnostic for the studio UI
  llm_model?: string              // diagnostic
  llm_duration_ms?: number        // diagnostic
}

// ─── Public entry point ─────────────────────────────────────────────
export async function composeDraft(meta: ArxivMeta, env?: LLMEnv): Promise<DraftArtifacts> {
  const slug = slugifyTitle(meta.title, meta.arxiv_id)
  const today = new Date().toISOString().slice(0, 10)

  // Try LLM first if configured
  if (env && env.LLM_API_KEY && env.LLM_BASE_URL && env.LLM_MODEL) {
    try {
      const llmCfg: LLMConfig = {
        apiKey: env.LLM_API_KEY,
        baseUrl: env.LLM_BASE_URL,
        model: env.LLM_MODEL,
      }
      const userPrompt = USER_PROMPT_TEMPLATE({
        arxiv_id: meta.arxiv_id,
        title: meta.title,
        authors: meta.authors,
        primary_subject: meta.primary_subject,
        abstract: meta.abstract,
      })
      const t0 = Date.now()
      const result = await callLLM(llmCfg, {
        system: SYSTEM_PROMPT,
        user: userPrompt,
        required_keys: ["meta_line", "lead", "sections", "takeaway", "banner_headline", "banner_palette"],
        temperature: 0.4,
        max_tokens: 4096,
        timeout_ms: 120_000,
      })
      const dur = Date.now() - t0
      const brief = result.parsed as BriefingJSON
      // Trust the schema we asked for; if sections is missing or empty, fall through.
      if (Array.isArray(brief.sections) && brief.sections.length > 0 && brief.takeaway && Array.isArray(brief.takeaway.paragraphs)) {
        const article_body = renderBriefingHtml(slug, meta, brief)
        const nav_html = await loadNavBlock(env as any)
        const page_html = wrapPageHtml({
          slug, title: meta.title,
          description: `A technical briefing on arXiv:${meta.arxiv_id}: ${(brief.lead || "").slice(0, 200)}${(brief.lead || "").length > 200 ? "…" : ""}`,
          banner_filename: `${slug}-banner.svg`,
          arxiv_id: meta.arxiv_id,
          article_body,
          nav_html,
        })
        const banner_svg = renderBannerSvg(slug, meta.title, brief)
        return {
          slug,
          meta_line: brief.meta_line || `${today} · ${estimateReadTime(meta.abstract)} min read · ${inferTopic(meta.primary_subject)}`,
          h1: meta.title,
          lead: brief.lead,
          page_html,
          banner_svg,
          index_card: makeIndexCard(meta, slug, brief, today),
          llm_used: true,
          llm_model: env.LLM_MODEL,
          llm_duration_ms: result.duration_ms ?? dur,
        }
      }
      // Fall through to rule-based if LLM returned a malformed response
      console.warn("[studio] LLM returned malformed response, falling back to rule-based composer")
    } catch (e) {
      console.warn(`[studio] LLM call failed (${e instanceof Error ? e.message : String(e)}); falling back to rule-based composer`)
      console.warn('[studio] LLM stack:', e instanceof Error ? e.stack : String(e))
    }
  }

  // Fallback: rule-based composer (the v0.1 implementation)
  return composeRuleBased(meta, slug, today)
}

// ─── Fallback composer (rule-based) ─────────────────────────────────
async function composeRuleBased(meta: ArxivMeta, slug: string, today: string): Promise<DraftArtifacts> {
  const minutes = estimateReadTime(meta.abstract)
  const subject = inferTopic(meta.primary_subject)
  const meta_line = `${today} · ${minutes} min read · ${subject}`
  const { lead, body } = ruleLeadAndBody(meta.abstract)
  const banner_svg = ruleBanner(slug, meta.title)
  const article_body = renderRuleHtml({ meta_line, h1: meta.title, lead, body, slug, arxiv_id: meta.arxiv_id, abs_url: meta.abs_url })
  const nav_html = await loadNavBlock({} as any)
  const page_html = wrapPageHtml({
    slug, title: meta.title,
    description: `A technical briefing on arXiv:${meta.arxiv_id}: ${lead.slice(0, 200)}${lead.length > 200 ? "…" : ""}`,
    banner_filename: `${slug}-banner.svg`,
    arxiv_id: meta.arxiv_id,
    article_body,
    nav_html,
  })
  return {
    slug,
    meta_line,
    h1: meta.title,
    lead,
    page_html,
    banner_svg,
    index_card: {
      meta: meta_line,
      title: meta.title,
      href: `/blog/${slug}/`,
      description: `A technical briefing on arXiv:${meta.arxiv_id}: ${lead}`,
    },
    llm_used: false,
  }
}

// ─── LLM-driven HTML rendering ─────────────────────────────────────
function renderBriefingHtml(slug: string, meta: ArxivMeta, brief: BriefingJSON): string {
  const banner_path = `/img/blog/${slug}-banner.svg`
  const paper_url = meta.abs_url
  const arxiv_id = meta.arxiv_id

  // Each section body — paragraphs, math, bullets, callout, rule
  const renderSection = (s: BriefingJSON["sections"][number]): string => {
    const parts: string[] = []
    for (const p of s.paragraphs) parts.push(`      <p>${p}</p>`)
    if (s.bullets && s.bullets.length > 0) {
      parts.push(`      <ul>`)
      for (const b of s.bullets) parts.push(`        <li>${b}</li>`)
      parts.push(`      </ul>`)
    }
    if (s.math && s.math.length > 0) {
      for (const m of s.math) {
        parts.push(`\n      <div class="math-block" data-label="${escAttr(m.label)}">\n        $$\n${m.tex}\n$$\n      </div>`)
      }
    }
    if (s.callout) parts.push(`      <div class="callout"><strong>Note:</strong> ${s.callout.text}</div>`)
    if (s.rule)    parts.push(`      <div class="rule">${s.rule.text}</div>`)
    return parts.join("\n")
  }

  const sectionsHtml = brief.sections
    .map(s => `      <h2>${escHtml(s.heading)}</h2>\n${renderSection(s)}`)
    .join("\n\n")

  const takeawayHtml = brief.takeaway
    ? `      <h2>${escHtml(brief.takeaway.heading || "Takeaway")}</h2>\n${
        brief.takeaway.paragraphs.map(p => `      <p>${p}</p>`).join("\n")
      }${
        brief.takeaway.bullets && brief.takeaway.bullets.length > 0
          ? `\n      <ul>\n${brief.takeaway.bullets.map(b => `        <li>${b}</li>`).join("\n")}\n      </ul>`
          : ""
      }`
    : ""

  return `<article class="article-body">
      <header style="margin-top: 64px; margin-bottom: 32px;">
        <div class="article-meta">${escHtml(brief.meta_line)}</div>
        <h1 style="font-size: 36px; line-height: 1.15; margin: 8px 0 16px;">${escHtml(meta.title)}</h1>
        <p class="lead" style="font-size: 18px; color: var(--text-muted); line-height: 1.5; margin: 0 0 16px;">
          ${escHtml(brief.lead)}
        </p>
        <a href="${escAttr(paper_url)}" class="btn-arxiv" target="_blank" rel="noopener">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 2px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
          Paper: arXiv:${escHtml(arxiv_id)}
        </a>
      </header>

      <img src="${escAttr(banner_path)}" alt="${escAttr(meta.title)} — banner" style="width: 100%; height: auto; display: block; border-radius: 14px; margin: 32px 0 28px; border: 1px solid var(--border);">

      <p><strong>arXiv:${escHtml(arxiv_id)}</strong> — ${escHtml(meta.title)}. ${escHtml(meta.authors.slice(0, 4).join(", "))}${meta.authors.length > 4 ? " et al." : ""}.</p>

${sectionsHtml}

${takeawayHtml}

      <p class="article-meta">Reference: arXiv:${escHtml(arxiv_id)} &middot; ${escHtml(meta.title)}</p>
    </article>`
}



// ─── HTML document wrapper ──────────────────────────────────────────
// Wraps an <article> fragment into a full HTML document with the same
// chrome as the hand-written blog posts: meta tags, KaTeX wired up,
// article-body <style>, /nav.css link. The nav block itself is injected
// post-publish by scripts/sync-nav.py so this worker doesn't have to
// carry the full nav template.
const KATEX_VERSION = "0.16.11"
const ARTICLE_BODY_STYLE = `<style>
  .article-body { max-width: 760px; margin: 0 auto; padding: 0 24px 96px; line-height: 1.7; }
  .article-body h2 { font-size: 24px; margin: 36px 0 12px; padding-top: 24px; border-top: 1px solid var(--border); }
  .article-body h3 { font-size: 18px; margin: 28px 0 8px; }
  .article-body p { margin: 14px 0; color: var(--text); }
  .article-body code { background: rgba(167,139,250,0.12); color: #ddd6fe; padding: 1px 6px; border-radius: 4px; font-size: 0.92em; }
  .article-body pre { background: var(--bg-code); border: 1px solid var(--border); border-radius: 10px; padding: 18px; overflow-x: auto; font-size: 13px; }
  .article-body pre code { background: none; color: #a5b4fc; padding: 0; }
  .article-body ul, .article-body ol { margin: 14px 0; padding-left: 24px; }
  .article-body li { margin: 6px 0; }
  .article-meta { font-family: var(--font-mono); font-size: 12px; color: var(--text-faint); letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 6px; }

  .math-block {
    background: linear-gradient(135deg, rgba(56,189,248,0.12), rgba(251,191,36,0.07));
    border: 1px solid rgba(56,189,248,0.32);
    border-radius: 12px;
    padding: 30px 24px 22px;
    margin: 26px 0;
    position: relative;
    overflow-x: auto;
  }
  .math-block::before {
    content: attr(data-label);
    position: absolute;
    top: 10px;
    left: 16px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: #7dd3fc;
    opacity: 0.85;
  }
  .article-body .katex { font-size: 1.05em; color: #e9e6ff; }
  .article-body .katex-display > .katex { font-size: 1.18em; }
</style>`

export interface WrapPageOptions {
  slug: string
  title: string
  description: string
  banner_filename: string
  arxiv_id: string
  article_body: string
  nav_html?: string | null   // optional pre-rendered <nav>...</nav> block
}

export function wrapPageHtml(opts: WrapPageOptions): string {
  const url = `https://ask-meridian.uk/blog/${opts.slug}/`
  const banner_url = `https://ask-meridian.uk/img/blog/${opts.banner_filename}`
  const navBlock = opts.nav_html
    ? `\n${opts.nav_html}\n`
    : ""
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${escHtml(opts.title)} &mdash; Meridian Blog</title>
<meta name="description" content="${escAttr(opts.description)}">
<meta property="og:title" content="${escAttr(opts.title)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${escAttr(url)}">
<meta property="og:image" content="${escAttr(banner_url)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${escAttr(banner_url)}">
<link rel="canonical" href="${escAttr(url)}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/style.css?v=20260527a">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/katex.min.css" crossorigin="anonymous">
<script defer src="https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/katex.min.js" crossorigin="anonymous"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/contrib/auto-render.min.js" crossorigin="anonymous" onload="renderMathInElement(document.body, {delimiters: [{left: '$$', right: '$$', display: true}, {left: '$', right: '$', display: false}, {left: '\\(', right: '\\)', display: false}, {left: '\\[', right: '\\]', display: true}], throwOnError: false});"></script>
${ARTICLE_BODY_STYLE}
<link rel="stylesheet" href="/nav.css?v=2026-05-14" data-nav-css>
</head>
<body>${navBlock}  <main id="main" style="padding-top: 48px;">
    ${opts.article_body}
  </main>
<script type="module" src="/blog/listen.js"></script>
</body>
</html>
`
}

// ─── LLM-driven banner SVG ──────────────────────────────────────────
function renderBannerSvg(slug: string, title: string, brief: BriefingJSON): string {
  // Title line 1: kicker / venue ("ARXIV BRIEFING" or topic)
  // Title line 2: banner_headline (gold)
  // Subtitle: brief.banner_subtitle
  // Palette drives accent colours
  const palette = paletteFor(brief.banner_palette || "mixed")
  const headline1 = (brief.banner_subtitle || inferTopic(brief.meta_line || "")).toUpperCase()
  const headline2 = (brief.banner_headline || title.split(/\s+/).slice(0, 4).join(" ")).toUpperCase()
  const safe = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  // Render the title across two lines, max 40 chars per line, with the gold treatment on line 2.
  const h1 = headline1.slice(0, 40)
  const h2 = headline2.slice(0, 40)
  // Pull arxiv id from slug's leading number (slug starts with arxiv id format usually)
  // Actually we don't have it here — caller could pass meta, but for the banner just use the title slug
  const tag = "ARXIV BRIEFING"

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
    <linearGradient id="accentGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%"   stop-color="${palette.accent1}" stop-opacity="0" />
      <stop offset="50%"  stop-color="${palette.accent1}" stop-opacity="0.95" />
      <stop offset="100%" stop-color="${palette.accent1}" stop-opacity="0" />
    </linearGradient>
    <filter id="glow"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="spectrumGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#ef4444"/>
      <stop offset="20%" stop-color="#f59e0b"/>
      <stop offset="40%" stop-color="#10b981"/>
      <stop offset="60%" stop-color="#3b82f6"/>
      <stop offset="80%" stop-color="#8b5cf6"/>
      <stop offset="100%" stop-color="#ec4899"/>
    </linearGradient>
    <pattern id="dotPattern" width="40" height="40" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1" fill="#58a6ff" fill-opacity="0.15"/>
    </pattern>
  </defs>

  <rect width="1920" height="1080" fill="url(#spaceGradient)"/>
  <rect width="1920" height="1080" fill="url(#dotPattern)"/>

  <rect x="30" y="30" width="1860" height="1020" rx="10" fill="none" stroke="#ffffff" stroke-width="1" opacity="0.08"/>

  <!-- Kicker chip -->
  <g transform="translate(960, 220)" text-anchor="middle" font-family="Arial, sans-serif">
    <g transform="translate(0, -90)">
      <rect x="-140" y="-18" width="280" height="32" rx="16" fill="#ffffff" fill-opacity="0.04" stroke="#ffffff" stroke-opacity="0.15" stroke-width="1"/>
      <circle cx="-110" cy="-2" r="3" fill="${palette.kicker}"/>
      <text y="4" font-size="13" font-weight="bold" fill="#a0afb7" letter-spacing="4">${safe(tag)}</text>
    </g>

    <!-- Title -->
    <text font-size="56" font-weight="800" fill="#ffffff" letter-spacing="5">${safe(h1)}</text>
    <text y="85" font-size="56" font-weight="800" fill="url(#goldText)" letter-spacing="5">${safe(h2)}</text>
    <text y="170" font-size="20" font-weight="500" fill="#a0afb7" letter-spacing="3" opacity="0.8">${safe((brief.banner_concept || title).slice(0, 100))}</text>
  </g>

  <!-- Bottom-half schematic: archetype picked by topic keywords in the
       LLM-provided banner_concept and the paper title. -->
  ${pickArchetype([
    brief.banner_concept || "",
    title,
    brief.banner_subtitle || "",
  ])({
    accent1: palette.accent1,
    accent2: palette.accent2,
    kicker:  palette.kicker,
    bg:      "#0a1625",
    ink:     "#ffffff",
  })}

  <!-- Corner markers -->
  <g stroke="${palette.kicker}" stroke-width="2" fill="none" opacity="0.5">
    <path d="M 50,50 L 150,50 M 50,50 L 50,150"/>
    <path d="M 1870,50 L 1770,50 M 1870,50 M 1870,150"/>
    <path d="M 50,1030 L 150,1030 M 50,1030 L 50,930"/>
    <path d="M 1870,1030 L 1770,1030 M 1870,1030 L 1870,930"/>
  </g>

  <!-- Footer marker -->
  <g transform="translate(960, 1010)" text-anchor="middle" font-family="sans-serif">
    <text font-size="15" font-weight="bold" fill="#ffffff" fill-opacity="0.4" letter-spacing="4">— ASK-MERIDIAN.UK —</text>
    <text y="24" font-size="13" fill="#718096" fill-opacity="0.8" letter-spacing="1">/blog/${safe(slug)}/</text>
  </g>
</svg>
`
}

function paletteFor(name: string): { accent1: string; accent2: string; kicker: string } {
  switch (name) {
    case "violet": return { accent1: "#a78bfa", accent2: "#7c3aed", kicker: "#a78bfa" }
    case "cyan":   return { accent1: "#38bdf8", accent2: "#0ea5e9", kicker: "#38bdf8" }
    case "amber":  return { accent1: "#fbbf24", accent2: "#f59e0b", kicker: "#fbbf24" }
    default:       return { accent1: "#a78bfa", accent2: "#38bdf8", kicker: "#38bdf8" }
  }
}

// ─── Rule-based composer (unchanged from v0.1, kept as fallback) ────
function renderRuleHtml(opts: {
  meta_line: string
  h1: string
  lead: string
  body: string[]
  slug: string
  arxiv_id: string
  abs_url: string
}): string {
  return `<article class="article-body">
      <header style="margin-top: 64px; margin-bottom: 32px;">
        <div class="article-meta">${escHtml(opts.meta_line)}</div>
        <h1 style="font-size: 36px; line-height: 1.15; margin: 8px 0 16px;">${escHtml(opts.h1)}</h1>
        <p class="lead" style="font-size: 18px; color: var(--text-muted); line-height: 1.5; margin: 0 0 16px;">
          ${escHtml(opts.lead)}
        </p>
        <a href="${escAttr(opts.abs_url)}" class="btn-arxiv" target="_blank" rel="noopener">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 2px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
          Paper: arXiv:${escHtml(opts.arxiv_id)}
        </a>
      </header>
      <img src="/img/blog/${escAttr(opts.slug)}-banner.svg" alt="${escAttr(opts.h1)} — banner" style="width: 100%; height: auto; display: block; border-radius: 14px; margin: 32px 0 28px; border: 1px solid var(--border);">
${opts.body.map(p => `      <p>${p}</p>`).join("\n")}
      <p class="article-meta">Reference: arXiv:${escHtml(opts.arxiv_id)} &middot; ${escHtml(opts.h1)}</p>
    </article>`
}

function ruleLeadAndBody(abstract: string): { lead: string; body: string[] } {
  const cleaned = abstract.replace(/\s+/g, " ").trim()
  const sentenceEnd = cleaned.search(/[.!?]\s/)
  let lead: string
  let rest: string
  if (sentenceEnd > 0 && sentenceEnd < 280) {
    lead = cleaned.slice(0, sentenceEnd + 1)
    rest = cleaned.slice(sentenceEnd + 1).trim()
  } else {
    lead = cleaned.slice(0, 280).trim()
    if (!/[.!?]$/.test(lead)) lead = lead.replace(/\s+\S*$/, "") + "…"
    rest = cleaned.slice(lead.length).trim()
  }
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

function ruleBanner(slug: string, title: string): string {
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

// ─── Helpers ─────────────────────────────────────────────────────────
function estimateReadTime(abstract: string): number {
  const words = abstract.split(/\s+/).length
  return Math.max(4, Math.min(12, Math.round(words / 200)))
}

function inferTopic(subject: string): string {
  const m = subject.match(/^(.*?)\s*\(/)
  return (m ? m[1] : subject).trim().toLowerCase()
}

function makeIndexCard(meta: ArxivMeta, slug: string, brief: BriefingJSON, today: string): DraftArtifacts["index_card"] {
  const meta_line = brief.meta_line || `${today} · ${estimateReadTime(meta.abstract)} min read · ${inferTopic(meta.primary_subject)}`
  const description = `A technical briefing on arXiv:${meta.arxiv_id}: ${(brief.lead || "").slice(0, 200)}${(brief.lead || "").length > 200 ? "…" : ""}`
  return {
    meta: meta_line,
    title: meta.title,
    href: `/blog/${slug}/`,
    description,
  }
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function escAttr(s: string): string {
  return escHtml(s).replace(/'/g, "&#39;")
}

// Re-export the LLMEnv shape so index.ts can pass it through.
// Matches the optional LLM_* fields on storage.ts's Env so callers can pass
// the full env object directly.
export interface LLMEnv {
  LLM_API_KEY?: string
  LLM_BASE_URL?: string
  LLM_MODEL?: string
}
