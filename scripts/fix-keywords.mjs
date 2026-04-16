#!/usr/bin/env node
/**
 * fix-keywords.mjs — bulk-add missing keywords + orb_class to legacy SKILL.md files
 *
 * Strategy:
 *   - Parse description field and slug to extract meaningful keywords
 *   - Lookup class from skill_orbit.py JSON output
 *   - Inject both fields into frontmatter without touching body
 *
 * Usage:
 *   node scripts/fix-keywords.mjs           # dry run (preview)
 *   node scripts/fix-keywords.mjs --write   # apply changes
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync }      from 'node:child_process'

const __dirname  = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT  = join(__dirname, '..')
const SKILLS_DIR = join(REPO_ROOT, 'skills')
const ORBIT_PY   = process.env.MERIDIAN_SKILL_ORBIT || './skills/skill_orbit.py'
const WRITE      = process.argv.includes('--write')

// ── Stop words to filter from description ─────────────────────────────────
const STOP = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'by','from','as','is','are','was','were','be','been','being','have','has',
  'had','do','does','did','will','would','could','should','may','might',
  'that','this','these','those','it','its','via','vs','plus','across',
  'including','such','all','both','each','few','more','most','other',
  'some','into','than','then','their','there','they','through','up','down',
  'not','no','so','if','when','which','who','what','how','where','why',
  'can','cannot','using','used','uses','use','based','style','way','also',
  'per','any','every','very','over','under','about','after','before',
])

function extractKeywords(slug, description) {
  // Words from slug
  const slugWords = slug.split('-').filter(w => w.length > 2 && !STOP.has(w))

  // Words from description — extract noun-like tokens
  const descWords = description
    .toLowerCase()
    .replace(/[^a-z0-9\s\-\/]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w))

  // Extract proper tech terms (CamelCase, acronyms, version numbers like V3)
  const techTerms = description
    .match(/\b([A-Z][a-zA-Z0-9]+|[A-Z]{2,}|v\d+(?:\.\d+)*)\b/g) || []
  const techLower = techTerms.map(t => t.toLowerCase()).filter(t => t.length > 1)

  // Combine, deduplicate, prioritise
  const seen = new Set()
  const kws = []
  const add = (w) => { if (!seen.has(w) && w.length > 1) { seen.add(w); kws.push(w) } }

  // Slug words first (highest signal)
  slugWords.forEach(add)
  // Tech terms (library names, version strings)
  techLower.forEach(add)
  // High-frequency desc words
  const freq = {}
  descWords.forEach(w => { freq[w] = (freq[w] || 0) + 1 })
  Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .forEach(([w]) => add(w))

  return [...new Set(kws)].slice(0, 20)
}

// ── Load orbital classes ───────────────────────────────────────────────────
console.log('Loading orbital classifications…')
const orbital = JSON.parse(execSync(`python3 ${ORBIT_PY} --json`, { encoding: 'utf8', timeout: 60000 }))
const classMap = Object.fromEntries(orbital.map(s => [s.slug, s.class]))

// ── Process each skill ─────────────────────────────────────────────────────
const slugs = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory()).map(d => d.name)

let updated = 0
let skipped = 0

for (const slug of slugs.sort()) {
  const path = join(SKILLS_DIR, slug, 'SKILL.md')
  if (!existsSync(path)) continue

  const raw = readFileSync(path, 'utf8')
  const m   = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) continue

  const frontmatter = m[1]
  const body        = m[2]

  const hasKeywords = /^keywords\s*:/m.test(frontmatter)
  const hasOrbClass = /^orb_class\s*:/m.test(frontmatter)

  if (hasKeywords && hasOrbClass) { skipped++; continue }

  // Parse description
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m)
  const description = descMatch ? descMatch[1].trim() : slug

  const keywords = extractKeywords(slug, description)
  const orbClass = classMap[slug] || 'moon'

  // Build updated frontmatter
  let fm = frontmatter
  if (!hasKeywords) {
    const kwLine = `keywords: [${keywords.map(k => `"${k}"`).join(', ')}]`
    fm = fm + '\n' + kwLine
  }
  if (!hasOrbClass) {
    fm = fm + '\norb_class: ' + orbClass
  }

  const newContent = `---\n${fm}\n---\n${body}`

  if (!WRITE) {
    console.log(`  [dry] ${slug.padEnd(35)} class=${orbClass}  keywords=[${keywords.slice(0,5).join(', ')}…]`)
  } else {
    writeFileSync(path, newContent, 'utf8')
    console.log(`  ✓ ${slug.padEnd(35)} +orb_class=${orbClass}  +${keywords.length} keywords`)
  }
  updated++
}

console.log(`\n${WRITE ? 'Updated' : 'Would update'} ${updated} skills, skipped ${skipped} (already complete)`)
if (!WRITE) console.log('\nRun with --write to apply.')
