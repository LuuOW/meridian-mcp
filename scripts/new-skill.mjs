#!/usr/bin/env node
/**
 * new-skill.mjs — interactive CLI to author a new Meridian skill
 *
 * Usage:
 *   node scripts/new-skill.mjs
 *   node scripts/new-skill.mjs --slug zero-knowledge-proofs   # pre-fill slug
 *
 * Creates:  skills/<slug>/SKILL.md
 * Then:     rebuilds embeddings + runs a test query to verify routing
 */

import { createInterface } from 'node:readline'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT  = join(__dirname, '..')
const SKILLS_DIR = join(REPO_ROOT, 'skills')

// ── Orbital classes ────────────────────────────────────────────────────────
const CLASSES = {
  planet:              'Broad anchor skill — core domain authority, high relevance mass',
  moon:                'Deep specialist — orbits a planet, tight coupling to one domain',
  comet:               'Niche burst — periodic, high-specificity, rare but critical',
  asteroid_belt:       'Utility layer — infrastructure glue, cross-cutting concerns',
  trojan:              'Companion skill — always appears alongside a lead skill',
  irregular_satellite: 'Exotic / emerging — cutting-edge, low prior but high signal',
}

// ── readline helper ────────────────────────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = (q, def = '') => new Promise(res =>
  rl.question(def ? `${q} [${def}]: ` : `${q}: `, ans => res(ans.trim() || def))
)

// ── Main ───────────────────────────────────────────────────────────────────
console.log('\n◎ Meridian — New Skill Wizard\n')

const slugArg = process.argv.find(a => a.startsWith('--slug='))?.split('=')[1]
  || (process.argv.indexOf('--slug') !== -1 ? process.argv[process.argv.indexOf('--slug') + 1] : '')

const slug = slugArg || await ask('Slug (kebab-case, e.g. zero-knowledge-proofs)')
if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
  console.error('Invalid slug — use lowercase letters, numbers, and hyphens only.')
  process.exit(1)
}

const skillDir = join(SKILLS_DIR, slug)
if (existsSync(skillDir)) {
  console.error(`Skill "${slug}" already exists at ${skillDir}`)
  process.exit(1)
}

const name        = await ask('Display name', slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))
const description = await ask('One-line description (shown in routing results)')

console.log('\nOrbital class:')
Object.entries(CLASSES).forEach(([k, v], i) => console.log(`  ${i + 1}. ${k.padEnd(22)} ${v}`))
const classIdx  = parseInt(await ask('Class number', '1')) - 1
const orb_class = Object.keys(CLASSES)[classIdx] || 'planet'

const keywords_raw = await ask('Keywords (comma-separated, for TASK_PROFILE matching)')
const keywords = keywords_raw.split(',').map(k => k.trim()).filter(Boolean)

const body = await ask('Short body / authority statement (1–2 sentences, can be edited later)',
  `Production patterns for ${name.toLowerCase()}. Covers core concepts, implementation approaches, and best practices.`)

rl.close()

// ── Generate SKILL.md ──────────────────────────────────────────────────────
const frontmatter = [
  '---',
  `name: ${slug}`,
  `description: ${description}`,
  `orb_class: ${orb_class}`,
  keywords.length ? `keywords: [${keywords.map(k => `"${k}"`).join(', ')}]` : '',
  '---',
].filter(Boolean).join('\n')

const content = `${frontmatter}

# ${name}

${body}

## Core Concepts

<!-- TODO: expand with canonical examples, code snippets, and production patterns -->

`

mkdirSync(skillDir, { recursive: true })
writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf8')

console.log(`\n✓ Created skills/${slug}/SKILL.md`)

// ── Test routing ───────────────────────────────────────────────────────────
const testQuery = await (async () => {
  const r2 = createInterface({ input: process.stdin, output: process.stdout })
  const q  = await new Promise(res =>
    r2.question(`\nTest query to verify routing (or Enter to skip): `, ans => { r2.close(); res(ans.trim()) })
  )
  return q
})()

if (testQuery) {
  console.log('\nRunning routing test…')
  try {
    // Rebuild embeddings first
    const out = execSync(
      `MERIDIAN_SKILLS_ROOT="${SKILLS_DIR}" node -e "
        import('/opt/meridian-mcp/src/embeddings.mjs').then(async m => {
          await m.buildSkillEmbeddings()
          const res = await m.rankByEmbedding('${testQuery.replace(/'/g, "\\'")}', ['${slug}'], 1)
          console.log(JSON.stringify(res))
        })
      "`,
      { encoding: 'utf8', timeout: 60000 }
    ).trim()
    const ranked = JSON.parse(out.split('\n').pop())
    const hit = ranked.find(r => r.slug === slug)
    if (hit) {
      console.log(`✓ "${slug}" ranked with similarity ${hit.sim.toFixed(4)} for that query`)
    } else {
      console.log(`⚠  "${slug}" not in top results — check keywords and description`)
    }
  } catch (e) {
    console.log('⚠  Routing test skipped (run server to rebuild embeddings):', e.message.slice(0, 80))
  }
}

console.log(`
Next steps:
  1. Edit skills/${slug}/SKILL.md — add real content, code examples, patterns
  2. node scripts/release.mjs patch  — bump version, push, publish npm
`)
