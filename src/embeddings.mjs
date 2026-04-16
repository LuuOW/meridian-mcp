/**
 * embeddings.mjs — semantic similarity layer using all-MiniLM-L6-v2
 *
 * Provides two functions used by routeTask():
 *   buildSkillEmbeddings() — pre-compute + cache embeddings for all skills
 *   rankByEmbedding(query, slugs) — returns slugs sorted by cosine similarity
 *
 * Model: Xenova/all-MiniLM-L6-v2 (23 MB, CPU-friendly, 384 dims)
 * First call downloads the model to ~/.cache/huggingface — subsequent calls use cache.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname }                           from 'node:path'
import { fileURLToPath }                           from 'node:url'

const __dirname_emb = dirname(fileURLToPath(import.meta.url))
const EMBED_CACHE   = join(__dirname_emb, '..', 'data', 'skill_embeddings.json')
const SKILLS_ROOT   = process.env.MERIDIAN_SKILLS_ROOT || '/opt/skills'
const MODEL_ID      = 'Xenova/all-MiniLM-L6-v2'

let _pipeline = null

// ── Lazy-load the embedding pipeline ─────────────────────────────────────────
async function getPipeline() {
  if (_pipeline) return _pipeline
  const { pipeline } = await import('@xenova/transformers')
  _pipeline = await pipeline('feature-extraction', MODEL_ID, {
    quantized: true,   // use quantized ONNX model (~23 MB vs ~91 MB)
  })
  return _pipeline
}

// ── Embed a single text → Float32Array ───────────────────────────────────────
export async function embed(text) {
  const pipe = await getPipeline()
  // mean-pooling over token embeddings
  const output = await pipe(text, { pooling: 'mean', normalize: true })
  return Array.from(output.data)  // plain JS array for JSON-serializability
}

// ── Cosine similarity (both arrays normalised → dot product is enough) ───────
function cosine(a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot  // already normalised
}

// ── Load cached embeddings ────────────────────────────────────────────────────
function loadCache() {
  if (!existsSync(EMBED_CACHE)) return {}
  try { return JSON.parse(readFileSync(EMBED_CACHE, 'utf8')) }
  catch { return {} }
}

function saveCache(data) {
  writeFileSync(EMBED_CACHE, JSON.stringify(data), { mode: 0o600 })
}

// ── Build / refresh skill embeddings ─────────────────────────────────────────
/**
 * Embed all SKILL.md files and cache to data/skill_embeddings.json.
 * Call once at server startup (or when corpus changes).
 * Only re-embeds skills whose file has changed since last cache.
 */
export async function buildSkillEmbeddings() {
  const { readdirSync, statSync } = await import('node:fs')
  const cache = loadCache()
  let updated = 0

  const slugs = readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
    .map(d => d.name)

  for (const slug of slugs) {
    const skillPath = join(SKILLS_ROOT, slug, 'SKILL.md')
    if (!existsSync(skillPath)) continue

    const mtime = statSync(skillPath).mtimeMs

    // Skip if cached and file hasn't changed
    if (cache[slug]?.mtime === mtime) continue

    // Build embedding text: description + first 400 chars of body
    let text = slug.replace(/-/g, ' ')
    try {
      const raw = readFileSync(skillPath, 'utf8')
      const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
      if (m) {
        const meta = m[1]
        const body = m[2].slice(0, 400)
        const desc = meta.match(/description:\s*(.+)/)?.[1] || ''
        const name = meta.match(/name:\s*(.+)/)?.[1] || slug
        text = `${name}. ${desc}. ${body}`
      }
    } catch {}

    cache[slug] = { mtime, vec: await embed(text) }
    updated++
  }

  if (updated > 0) {
    saveCache(cache)
    console.log(`[embeddings] built ${updated} skill embedding(s) → ${EMBED_CACHE}`)
  }

  return cache
}

// ── Rank candidate slugs by semantic similarity to a query ───────────────────
/**
 * Returns slugs sorted by descending cosine similarity to the query.
 * Use this to pre-filter the orbital scorer to the top-K candidates.
 *
 * @param {string}   query  — raw task text
 * @param {string[]} slugs  — all available skill slugs
 * @param {number}   topK   — how many to return (default: 25)
 * @returns {Promise<{slug:string, sim:number}[]>}
 */
export async function rankByEmbedding(query, slugs, topK = 25) {
  const cache = loadCache()

  // Filter to slugs that have cached embeddings
  const available = slugs.filter(s => cache[s]?.vec)
  if (!available.length) return slugs.map(s => ({ slug: s, sim: 0 }))

  const qvec = await embed(query)

  const ranked = available.map(slug => ({
    slug,
    sim: cosine(qvec, cache[slug].vec),
  }))

  ranked.sort((a, b) => b.sim - a.sim)

  // Always include the top-K; also pass through any slug not yet embedded
  const notCached = slugs.filter(s => !cache[s]?.vec)
  return [...ranked.slice(0, topK), ...notCached.map(s => ({ slug: s, sim: 0 }))]
}
