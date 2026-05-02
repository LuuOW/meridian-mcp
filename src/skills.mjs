/**
 * skills.mjs — orbital routing with semantic embedding pre-filter
 *
 * Pipeline:
 *   1. Embedding layer (all-MiniLM-L6-v2) ranks ALL skills by semantic similarity
 *   2. Top-40 candidates passed to skill_orbit.py for orbital physics scoring
 *   3. Orbital scorer returns final ranked list with route_score + confidence
 *
 * This gives broad keyword coverage (embedding) AND precise physics ranking (orbit).
 */
import { spawn }                                  from 'node:child_process'
import { readFileSync, existsSync, readdirSync }   from 'node:fs'
import { join }                                    from 'node:path'
import { buildSkillEmbeddings, rankByEmbedding }   from './embeddings.mjs'
import { parseFrontmatter }                        from './skill-md.mjs'

const SKILLS_ROOT     = process.env.MERIDIAN_SKILLS_ROOT   || '/opt/skills'
const SKILL_ORBIT_PY  = process.env.MERIDIAN_SKILL_ORBIT   || '/opt/skills/skill_orbit.py'
const PYTHON          = process.env.MERIDIAN_PYTHON        || 'python3'

// ── Embedding warm-up on module load ─────────────────────────────────────────
// Runs in background — doesn't block the server from starting
let _embeddingsReady = false
buildSkillEmbeddings()
  .then(() => { _embeddingsReady = true; console.log('[embeddings] ready') })
  .catch(e  => console.warn('[embeddings] build failed, falling back to full corpus:', e.message))

function runOrbit(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(PYTHON, [SKILL_ORBIT_PY, ...args, '--json'], { timeout: 20_000 })
    let out = '', err = ''
    p.stdout.on('data', d => (out += d))
    p.stderr.on('data', d => (err += d))
    p.on('close', code => {
      if (code !== 0 && !out) return reject(new Error(`skill_orbit.py exited ${code}: ${err}`))
      try { resolve(JSON.parse(out)) }
      catch (e) { reject(new Error(`invalid JSON from skill_orbit.py: ${e.message}`)) }
    })
    p.on('error', reject)
  })
}

// ── Route cache ───────────────────────────────────────────────────────────────
const _routeCache    = new Map()
const ROUTE_CACHE_TTL = 90_000

// ── Main routing function ─────────────────────────────────────────────────────
export async function routeTask(task, limit = 7) {
  if (!task || typeof task !== 'string') throw new Error('task must be a non-empty string')
  const key = `${task.trim().toLowerCase()}::${limit}`
  const hit = _routeCache.get(key)
  if (hit && Date.now() - hit.ts < ROUTE_CACHE_TTL) return hit.result

  // ── Step 1: embedding pre-filter (when ready) ─────────────────────────────
  let filterArgs = []
  if (_embeddingsReady) {
    try {
      const allSlugs = listSkillsFromDisk()
      const ranked   = await rankByEmbedding(task, allSlugs, 40)
      const top40    = ranked.map(r => r.slug)
      // Pass candidate set to orbital scorer via --candidates flag
      filterArgs = ['--candidates', top40.join(',')]
    } catch (e) {
      console.warn('[embeddings] ranking failed, using full corpus:', e.message)
    }
  }

  // ── Step 2: orbital physics scoring ──────────────────────────────────────
  const data = await runOrbit([
    '--route', '--task', task,
    '--limit', String(Math.max(1, Math.min(20, limit))),
    ...filterArgs,
  ])

  const result = {
    task:               data.task,
    confidence:         data.confidence        || 'moderate',
    top_primary_score:  data.top_primary_score ?? null,
    selected: (data.selected_skills || []).map(s => ({
      slug:        s.slug,
      class:       s.class,
      parent:      s.parent,
      route_score: s.route_score,
      why:         s.why,
    })),
  }
  _routeCache.set(key, { ts: Date.now(), result })
  setTimeout(() => _routeCache.delete(key), ROUTE_CACHE_TTL)
  return result
}

export async function listAllSkills() {
  return runOrbit([])
}

export function listSkillsFromDisk() {
  return readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
    .map(d => d.name)
    .sort()
}

export function getSkill(slug) {
  if (!/^[a-z0-9_-]+$/i.test(slug)) throw new Error('invalid skill slug')
  const path = join(SKILLS_ROOT, slug, 'SKILL.md')
  if (!existsSync(path)) throw new Error(`skill not found: ${slug}`)
  const content = readFileSync(path, 'utf8')
  const { frontmatter, body } = parseFrontmatter(content)
  return { slug, frontmatter, body }
}

export function searchSkills(query) {
  const q = (query || '').toLowerCase().trim()
  if (!q) return []
  const slugs = listSkillsFromDisk()
  const hits = []
  for (const slug of slugs) {
    try {
      const { frontmatter, body } = getSkill(slug)
      const text = (frontmatter.name + ' ' + frontmatter.description + ' ' + body).toLowerCase()
      if (text.includes(q)) {
        const idx = text.indexOf(q)
        const snippet = body.slice(Math.max(0, idx - 80), idx + 200).replace(/\s+/g, ' ').trim()
        hits.push({ slug, description: frontmatter.description || '', snippet })
      }
    } catch { /* skip */ }
  }
  return hits.slice(0, 20)
}
