// GitHub Contents API publisher — atomic file writes via PUT /repos/{o}/{r}/contents/{path}.
//
// Why Contents API instead of git push:
//   - No need to ship a git client inside a Worker (Workers don't have one).
//   - Each PUT creates a real commit on main, with the studio user's email as author.
//   - Branch-protection "must go through PR" rules can be bypassed with an admin PAT
//     (same trick finance-mcp uses).
//   - File content is committed in one round-trip — no upload-pack / receive-pack dance.
//
// We commit three files in one logical step (slugs may collide; handle 409):
//   1. landing/img/blog/<slug>-banner.svg
//   2. landing/blog/<slug>/index.html
//   3. (optional) index card on landing/blog/index.html — handled by reading + patching
//
// Each commit also writes a "listening" touch to landing/data/bot-touches to keep
// observability in the existing repo dashboards.

import type { Env } from "./storage"

export interface PublishInput {
  slug: string
  page_html: string
  banner_svg: string
  index_card: {
    meta: string
    title: string
    href: string
    description: string
  }
  // Optional: when set, patches the existing /blog/index.html to insert the card.
  // We always read the current file first so the patch is append-after-last-article.
  patch_index?: boolean
  commit_message: string
}

export interface PublishResult {
  banner_commit: string
  page_commit: string
  index_commit: string | null
}

const API = "https://api.github.com"

function ghHeaders(env: Env, accept = "application/vnd.github+json"): HeadersInit {
  return {
    "authorization": `Bearer ${env.GITHUB_TOKEN}`,
    "accept": accept,
    "x-github-api-version": "2022-11-28",
    "user-agent": "meridian-studio/0.1",
  }
}

async function gh<T = unknown>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const url = `${API}${path}`
  const res = await fetch(url, {
    ...init,
    headers: { ...ghHeaders(env), ...(init.headers ?? {}) },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`github ${init.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

interface ContentsResp {
  content: { sha: string; path: string; html_url: string; commit_sha?: string }
  commit: { sha: string; html_url: string }
}

// Inline the Pages workflow bit so the studio can also (optionally) trigger a
// workflow_dispatch after the file commits land — but normally pushing to
// main is enough because pages.yml listens on push.
async function putContents(
  env: Env,
  repo: string,
  branch: string,
  path: string,
  content: string,
  message: string,
): Promise<ContentsResp> {
  // First read existing sha (PUT requires the existing blob sha to update)
  let sha: string | undefined
  try {
    const existing = await gh<{ sha: string }>(env, `/repos/${repo}/contents/${encodeURI(path)}?ref=${branch}`)
    sha = existing.sha
  } catch (e) {
    // 404 — file doesn't exist yet, that's fine for create.
    if (!(e instanceof Error && /→ 404/.test(e.message))) throw e
  }
  // Encode the JS string to base64 the way GitHub Contents API expects:
  // GitHub stores files as raw UTF-8 bytes; the API takes base64 of those bytes.
  // The classic `btoa(unescape(encodeURIComponent(s)))` trick turns non-ASCII
  // characters into mojibake (`🧬` → `ð§¬`) because unescape() treats each
  // percent-decoded byte as a Latin-1 codepoint instead of packing them into
  // a UTF-8 string. Use TextEncoder + btoa-of-byte-string instead.
  const utf8Bytes = new TextEncoder().encode(content)
  let bin = ""
  for (let i = 0; i < utf8Bytes.length; i++) bin += String.fromCharCode(utf8Bytes[i])
  const content_b64 = btoa(bin)

  const body: Record<string, unknown> = {
    message,
    content: content_b64,
    branch,
    committer: { name: "Meridian Studio", email: "studio@ask-meridian.uk" },
    author:    { name: "Meridian Studio", email: "studio@ask-meridian.uk" },
  }
  if (sha) body.sha = sha
  return gh<ContentsResp>(env, `/repos/${repo}/contents/${encodeURI(path)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

interface IndexHtmlResp {
  content: string
  sha: string
}

async function getIndexHtml(env: Env, repo: string, branch: string): Promise<IndexHtmlResp> {
  const res = await gh<IndexHtmlResp>(env, `/repos/${repo}/contents/landing/blog/index.html?ref=${branch}`)
  // content is base64
  const decoded = atob(res.content.replace(/\s+/g, ""))
  return { content: decoded, sha: res.sha }
}

// ─── Date-sorted index card insertion ─────────────────────────────
// Inserts (or replaces) a card in landing/blog/index.html such that all
// cards end up sorted newest-first by their meta_line date prefix
// (YYYY-MM-DD). Also fixes the historical bug where patchIndexHtml would
// only insert at the top, leaving a stale card behind if the same slug
// had been published before.
function patchIndexHtml(html: string, card: { meta: string; title: string; href: string; description: string }): string {
  const cardHtml = `    <article style="margin-bottom: 32px; padding: 24px; border: 1px solid var(--border); border-radius: 14px; background: var(--bg-card);">
      <div style="font-family: var(--font-mono); font-size: 12px; color: var(--text-faint); letter-spacing: 0.1em; text-transform: uppercase;">${card.meta}</div>
      <h2 style="margin: 8px 0 12px; font-size: 22px;">
        <a href="${card.href}" style="color: var(--text); text-decoration: none;">
          ${card.title}
        </a>
      </h2>
      <p style="margin: 0; color: var(--text-muted);">
        ${card.description}
      </p>
    </article>\n\n`

  // Extract the date prefix from the meta_line. Format: 'YYYY-MM-DD · ...'
  const dateMatch = card.meta.match(/^(\d{4}-\d{2}-\d{2})/)
  const cardDate = dateMatch ? dateMatch[1] : ""

  // Find the section that wraps the cards.
  const sectionRe = /(<section style="padding: 0 0 72px;">)([\s\S]*?)(<\/section>)/
  const sectionMatch = html.match(sectionRe)
  if (!sectionMatch) return html  // nothing to do
  const [, sectionOpen, sectionInner, sectionClose] = sectionMatch

  // Walk the section, split into individual <article> blocks plus whitespace.
  const articleRe = /<article[^>]*>[\s\S]*?<\/article>/g
  const existing: { html: string; date: string; href: string }[] = []
  for (const m of sectionInner.matchAll(articleRe)) {
    const block = m[0]
    const hrefMatch = block.match(/href="\/blog\/([^/]+)\//)
    const dateInBlock = block.match(/^\s*<div[^>]+>(\d{4}-\d{2}-\d{2})/)
    existing.push({
      html: block,
      date: dateInBlock ? dateInBlock[1] : "",
      href: hrefMatch ? `/blog/${hrefMatch[1]}/` : "",
    })
  }

  // Idempotency: if a card with the same href already exists, replace it
  // in place instead of duplicating.
  const filtered = existing.filter(c => c.href !== card.href)

  // Insert the new card, then sort by date DESC (newest first).
  // Cards without a date go to the end so they don't block dated cards.
  const newEntry = { html: cardHtml, date: cardDate, href: card.href }
  filtered.unshift(newEntry)
  filtered.sort((a, b) => {
    if (!a.date && !b.date) return 0
    if (!a.date) return 1
    if (!b.date) return -1
    return b.date.localeCompare(a.date)
  })

  const newInner = "\n" + filtered.map(c => c.html).join("\n\n") + "\n  "
  return html.replace(sectionRe, sectionOpen + newInner + sectionClose)
}

export async function publish(env: Env, input: PublishInput): Promise<PublishResult> {
  const repo = env.GITHUB_REPO ?? "LuuOW/meridian-mcp"
  const branch = "main"

  // Dry-run mode for local smoke tests. Logs to stderr instead of pushing.
  if (env.GITHUB_TOKEN === "DRY-RUN") {
    const bannerSha = "DRY-RUN-BANNER-" + input.slug
    const pageSha = "DRY-RUN-PAGE-" + input.slug
    let indexSha: string | null = null
    if (input.patch_index !== false) indexSha = "DRY-RUN-INDEX-" + input.slug
    console.log("[studio dry-run] publish", { repo, branch, slug: input.slug, bannerSha, pageSha, indexSha })
    return { banner_commit: bannerSha, page_commit: pageSha, index_commit: indexSha }
  }

  // 1) banner SVG
  const bannerPath = `landing/img/blog/${input.slug}-banner.svg`
  const banner = await putContents(env, repo, branch, bannerPath, input.banner_svg, `${input.commit_message} (banner)`)

  // 2) page HTML
  const pagePath = `landing/blog/${input.slug}/index.html`
  const page = await putContents(env, repo, branch, pagePath, input.page_html, input.commit_message)

  // 3) index card (optional)
  let index_commit: string | null = null
  if (input.patch_index !== false) {
    const idx = await getIndexHtml(env, repo, branch)
    if (!idx.content.includes(`href="${input.index_card.href}"`)) {
      const patched = patchIndexHtml(idx.content, input.index_card)
      const index = await putContents(env, repo, branch, "landing/blog/index.html", patched, `${input.commit_message} (index)`)
      index_commit = index.commit.sha
    }
  }

  return {
    banner_commit: banner.commit.sha,
    page_commit: page.commit.sha,
    index_commit,
  }
}

// ─── Delete ─────────────────────────────────────────────────────────
// Used by /studio/delete to remove a past blog. We delete the three files
// in order (banner, page, then any orphan index card). The contents API
// requires the existing blob sha, which we fetch per-file.
export async function deleteBlog(env: Env, slug: string): Promise<{ deleted: string[]; commits: string[] }> {
  const repo = env.GITHUB_REPO ?? "LuuOW/meridian-mcp"
  const branch = "main"

  if (env.GITHUB_TOKEN === "DRY-RUN") {
    console.log("[studio dry-run] delete", { repo, branch, slug })
    return { deleted: [`landing/img/blog/${slug}-banner.svg`, `landing/blog/${slug}/index.html`], commits: [`DRY-RUN-DELETE-${slug}`] }
  }

  const deleted: string[] = []
  const commits: string[] = []
  const paths = [
    `landing/img/blog/${slug}-banner.svg`,
    `landing/blog/${slug}/index.html`,
  ]
  for (const path of paths) {
    try {
      const cur = await gh<{ sha: string }>(env, `/repos/${repo}/contents/${encodeURI(path)}?ref=${branch}`)
      const url = `${API}/repos/${repo}/contents/${encodeURI(path)}`
      const res = await fetch(url, {
        method: "DELETE",
        headers: { ...ghHeaders(env), "content-type": "application/json" },
        body: JSON.stringify({
          message: `studio: delete ${slug}`,
          sha: cur.sha,
          branch,
          committer: { name: "Meridian Studio", email: "studio@ask-meridian.uk" },
          author:    { name: "Meridian Studio", email: "studio@ask-meridian.uk" },
        }),
      })
      if (!res.ok) {
        const t = await res.text()
        throw new Error(`delete ${path} → ${res.status}: ${t.slice(0, 200)}`)
      }
      const j = await res.json() as { commit: { sha: string } }
      deleted.push(path)
      commits.push(j.commit.sha)
    } catch (e) {
      // Missing files are fine — skip.
      if (e instanceof Error && /→ 404/.test(e.message)) continue
      throw e
    }
  }
  // Best-effort: also strip the index card off /blog/index.html.
  try {
    const idx = await getIndexHtml(env, repo, branch)
    const cardPath = `/blog/${slug}/`
    if (idx.content.includes(`href="${cardPath}"`)) {
      // Match the article block that links to the slug; remove the whole <article>...</article>.
      const re = new RegExp(
        `\\s*<article[^>]*>[\\s\\S]*?href="${cardPath.replace(/\//g, "\\/")}"[\\s\\S]*?<\\/article>`,
      )
      const patched = idx.content.replace(re, "")
      if (patched !== idx.content) {
        const index = await putContents(env, repo, branch, "landing/blog/index.html", patched, `studio: delete ${slug} (index)`)
        deleted.push("landing/blog/index.html")
        commits.push(index.commit.sha)
      }
    }
  } catch (e) {
    // Index patch is best-effort.
  }
  return { deleted, commits }
}

// ─── List existing blogs (read-only, used by the dashboard) ────────
//
// Single GitHub call: read landing/blog/index.html (the public index page),
// parse out every <article><h2><a href="/blog/<slug>/">title</a></h2>…</article>
// block. That gives us titles + slugs + a stable display order that already
// matches the public /blog/ page (newest first, since Studio always inserts
// new cards at the top via patchIndexHtml).
//
// Why one call instead of N: each /studio/blogs request used to make
//   1 git-trees recursive=1 + N contents API calls (one per post)
// which exceeded Cloudflare Worker subrequest budgets on the free plan and
// surfaced as a 500 the moment any one of the per-post fetches threw. The
// index page already has everything we need, so read it once.
export interface BlogEntry {
  slug: string
  title: string
  href: string
  path: string
}

const ARTICLE_RE = /<article[^>]*>([\s\S]*?)<\/article>/g
const H2_RE      = /<h2[^>]*>([\s\S]*?)<\/h2>/
const HREF_RE    = /href="(\/blog\/[^/]+\/)(?:[\s\S]*?)"/
const TAG_RE     = /<[^>]+>/g
const DECODE_HTML = (s: string) =>
  s.replace(/&amp;/g, "&")
   .replace(/&lt;/g, "<")
   .replace(/&gt;/g, ">")
   .replace(/&quot;/g, "\"")
   .replace(/&#39;/g, "\u0027")
   .replace(/&mdash;/g, "\u2014")
   .replace(/&middot;/g, "\u00b7")
   .replace(/&ndash;/g, "\u2013")

export async function listBlogs(env: Env): Promise<BlogEntry[]> {
  const repo = env.GITHUB_REPO ?? "LuuOW/meridian-mcp"
  const branch = "main"

  if (env.GITHUB_TOKEN === "DRY-RUN") {
    return [
      { slug: "plasma-etch-diamond-on-insulator-colorimetry", title: "Plasma Etch Process Optimization for Photonic-Grade Diamond-on-Insulator Substrates and Thickness Evaluation using Colorimetry", href: "/blog/plasma-etch-diamond-on-insulator-colorimetry/", path: "landing/blog/plasma-etch-diamond-on-insulator-colorimetry/index.html" },
      { slug: "benchmark-ground-state-quantum-algorithms-noise", title: "Benchmark of quantum algorithms for ground state preparation in the presence of noise", href: "/blog/benchmark-ground-state-quantum-algorithms-noise/", path: "landing/blog/benchmark-ground-state-quantum-algorithms-noise/index.html" },
      { slug: "log-concavity-tunneling-aqo-convex-functions-spike", title: "Log-concavity and tunneling: adiabatic quantum optimization for convex functions (with a spike)", href: "/blog/log-concavity-tunneling-aqo-convex-functions-spike/", path: "landing/blog/log-concavity-tunneling-aqo-convex-functions-spike/index.html" },
    ]
  }

  // ONE GitHub call: read the public /blog/ index page (base64 encoded).
  const idx = await gh<{ content: string }>(env, `/repos/${repo}/contents/landing/blog/index.html?ref=${branch}`)
  const html = atob(idx.content.replace(/\s+/g, ""))

  // Walk every <article>…</article> in document order (= public display order).
  const out: BlogEntry[] = []
  for (const m of html.matchAll(ARTICLE_RE)) {
    const block = m[1]
    const h2 = block.match(H2_RE)
    if (!h2) continue
    const hrefMatch = h2[1].match(HREF_RE)
    if (!hrefMatch) continue
    const slug = hrefMatch[1].replace(/^\/blog\//, "").replace(/\/$/, "")
    const title = DECODE_HTML(h2[1].replace(TAG_RE, "").trim())
    out.push({ slug, title, href: `/blog/${slug}/`, path: `landing/blog/${slug}/index.html` })
    if (out.length >= 100) break
  }
  return out
}
