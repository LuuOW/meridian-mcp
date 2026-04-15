// skills.mjs — thin wrapper over /opt/skills/skill_orbit.py
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SKILLS_ROOT     = process.env.MERIDIAN_SKILLS_ROOT   || '/opt/skills'
const SKILL_ORBIT_PY  = process.env.MERIDIAN_SKILL_ORBIT   || '/opt/skills/skill_orbit.py'
const PYTHON          = process.env.MERIDIAN_PYTHON        || 'python3'

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

export async function routeTask(task, limit = 5) {
  if (!task || typeof task !== 'string') throw new Error('task must be a non-empty string')
  const data = await runOrbit(['--route', '--task', task, '--limit', String(Math.max(1, Math.min(20, limit)))])
  return {
    task:     data.task,
    selected: (data.selected_skills || []).map(s => ({
      slug:        s.slug,
      class:       s.class,
      parent:      s.parent,
      route_score: s.route_score,
      why:         s.why,
    })),
  }
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
  // Parse frontmatter (between --- lines)
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  const frontmatter = {}
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^([a-z_]+):\s*(.*)$/i)
      if (kv) frontmatter[kv[1]] = kv[2].trim()
    }
    return { slug, frontmatter, body: m[2].trim() }
  }
  return { slug, frontmatter: {}, body: content }
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
