#!/usr/bin/env node
/**
 * audit.mjs — corpus health report for the Meridian skill system
 *
 * Usage:
 *   node scripts/audit.mjs              # full report to stdout
 *   node scripts/audit.mjs --json       # machine-readable JSON
 *   node scripts/audit.mjs --fix        # auto-apply safe fixes (class upgrades)
 *   node scripts/audit.mjs --watch      # re-run every 6h (no system service needed)
 *
 * What it checks:
 *   1. Promotion candidates  — moons close to planet threshold
 *   2. Collision risk        — high overlap_risk pairs (competing skills)
 *   3. Belt candidates       — moons that should degrade to asteroid_belt
 *   4. High-drag bodies      — skills with excessive activation friction
 *   5. Staleness / decay     — skills approaching erosion (12-step sim)
 *   6. Accretion signals     — clusters of belt fragments that could merge
 *   7. Missing keywords      — SKILL.md files with no keywords field
 *   8. Thin content          — SKILL.md files under 300 words
 */

import { execSync }                              from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname }                          from 'node:path'
import { fileURLToPath }                          from 'node:url'

const __dirname  = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT  = join(__dirname, '..')
const SKILLS_DIR = join(REPO_ROOT, 'skills')
const ORBIT_PY   = process.env.MERIDIAN_SKILL_ORBIT || '/opt/skills/skill_orbit.py'
const REPORT_DIR = join(REPO_ROOT, 'data')
const REPORT_OUT = join(REPORT_DIR, 'audit-report.json')

const JSON_MODE  = process.argv.includes('--json')
const FIX_MODE   = process.argv.includes('--fix')
const WATCH_MODE = process.argv.includes('--watch')

// ── Helpers ────────────────────────────────────────────────────────────────
const run = (cmd) => execSync(cmd, { encoding: 'utf8', timeout: 60000 })
const log = (...a) => { if (!JSON_MODE) console.log(...a) }
const warn = (...a) => { if (!JSON_MODE) console.warn(...a) }

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length
}

function parseSkillMd(slug) {
  const path = join(SKILLS_DIR, slug, 'SKILL.md')
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf8')
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) return { slug, raw, meta: {}, body: raw, words: wordCount(raw) }
  const meta = {}
  for (const line of m[1].split('\n')) {
    const [k, ...rest] = line.split(':')
    if (k && rest.length) meta[k.trim()] = rest.join(':').trim()
  }
  const hasKeywords = /keywords\s*:/i.test(m[1])
  return { slug, raw, meta, body: m[2], words: wordCount(m[2]), hasKeywords }
}

// ── Run orbital classifier + simulator ────────────────────────────────────
log('\n◎ Meridian Corpus Audit\n')
log('Running orbital classifier…')

let orbitalData, simData
try {
  orbitalData = JSON.parse(run(`python3 ${ORBIT_PY} --json`))
} catch (e) {
  warn('Failed to run skill_orbit.py:', e.message)
  process.exit(1)
}

log('Running 12-step orbital simulation…')
try {
  simData = JSON.parse(run(`python3 ${ORBIT_PY} --simulate 12 --json`))
} catch (e) {
  warn('Simulation failed:', e.message)
  simData = { events: [], final_states: [] }
}

const bySlug     = Object.fromEntries(orbitalData.map(s => [s.slug, s]))
const simBySlug  = Object.fromEntries(simData.final_states.map(s => [s.slug, s]))

// ── 1. Promotion candidates ────────────────────────────────────────────────
const promotions = orbitalData
  .filter(s => s.class === 'moon' && s.scores.planet_score >= 0.44)
  .sort((a, b) => b.scores.planet_score - a.scores.planet_score)
  .map(s => ({
    slug:         s.slug,
    planet_score: round(s.scores.planet_score),
    mass:         round(s.scores.scope),
    independence: round(s.scores.independence),
    sim_promoted: simData.events.some(e => e.type === 'promotion' && e.skill === s.slug),
  }))

// ── 2. Collision risk (high overlap pairs) ─────────────────────────────────
const collisions = orbitalData
  .filter(s => s.scores.overlap_risk > 0.35)
  .sort((a, b) => b.scores.overlap_risk - a.scores.overlap_risk)
  .map(s => ({
    slug:         s.slug,
    class:        s.class,
    overlap_risk: round(s.scores.overlap_risk),
    parent:       s.parent,
  }))

// Find same-parent pairs that could collide
const byParent = {}
for (const s of orbitalData) {
  if (!s.parent) continue
  if (!byParent[s.parent]) byParent[s.parent] = []
  byParent[s.parent].push(s.slug)
}
const collision_clusters = Object.entries(byParent)
  .filter(([, slugs]) => slugs.length >= 3)
  .map(([parent, slugs]) => ({ parent, slugs }))

// ── 3. Demotion candidates (moons → asteroid belt) ─────────────────────────
const demotions = orbitalData
  .filter(s => s.class === 'moon'
    && s.scores.asteroid_belt_score >= 0.40
    && s.scores.fragmentation >= 0.35)
  .sort((a, b) => b.scores.asteroid_belt_score - a.scores.asteroid_belt_score)
  .map(s => ({
    slug:               s.slug,
    asteroid_belt_score: round(s.scores.asteroid_belt_score),
    fragmentation:      round(s.scores.fragmentation),
    overlap_risk:       round(s.scores.overlap_risk),
  }))

// ── 4. High-drag bodies ────────────────────────────────────────────────────
const high_drag = orbitalData
  .filter(s => s.scores.drag > 0.35)
  .sort((a, b) => b.scores.drag - a.scores.drag)
  .map(s => ({
    slug:       s.slug,
    class:      s.class,
    drag:       round(s.scores.drag),
    suggestion: s.scores.drag >= 0.55
      ? 'reduce setup cost — split into smaller focused skill or add explicit trigger keywords'
      : 'acceptable but worth watching',
  }))

// ── 5. Decay / staleness from simulation ──────────────────────────────────
const decaying = simData.final_states
  .filter(s => s.staleness > 0.20 || s.health < 0.65)
  .sort((a, b) => b.staleness - a.staleness)
  .map(s => ({
    slug:      s.slug,
    staleness: round(s.staleness),
    health:    round(s.health),
    trust:     round(s.trust),
    action:    s.staleness > 0.35 ? 'refresh content urgently' : 'monitor',
  }))

// ── 6. Accretion signals (belt fragments that could merge) ─────────────────
const beltSlugs = orbitalData.filter(s => s.class === 'asteroid_belt').map(s => s.slug)
// Group by latent_parent
const beltByParent = {}
for (const slug of beltSlugs) {
  const p = bySlug[slug]?.latent_parent || 'none'
  if (!beltByParent[p]) beltByParent[p] = []
  beltByParent[p].push(slug)
}
const accretion = Object.entries(beltByParent)
  .filter(([, slugs]) => slugs.length >= 2)
  .map(([latent_parent, slugs]) => ({ latent_parent, slugs,
    suggestion: `consider merging into a single '${latent_parent}-patterns' moon` }))

// ── 7. Missing keywords ────────────────────────────────────────────────────
const { readdirSync } = await import('node:fs')
const allSlugs = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory()).map(d => d.name)

const missing_keywords = []
const thin_content = []

for (const slug of allSlugs) {
  const parsed = parseSkillMd(slug)
  if (!parsed) continue
  if (!parsed.hasKeywords) missing_keywords.push(slug)
  if (parsed.words < 100)  thin_content.push({ slug, words: parsed.words })
}

// ── 8. Sim-promoted bodies (suggest committing class update) ───────────────
const sim_promotions = simData.events
  .filter(e => e.type === 'promotion')
  .map(e => ({ slug: e.skill, detail: e.detail }))

// ── Build report ───────────────────────────────────────────────────────────
const report = {
  generated_at:      new Date().toISOString(),
  corpus_size:       allSlugs.length,
  summary: {
    promotion_candidates: promotions.length,
    collision_risk:       collisions.length,
    demotion_candidates:  demotions.length,
    high_drag_skills:     high_drag.length,
    decaying_skills:      decaying.length,
    accretion_clusters:   accretion.length,
    missing_keywords:     missing_keywords.length,
    thin_content_skills:  thin_content.length,
  },
  promotions,
  sim_promotions,
  collisions,
  collision_clusters,
  demotions,
  high_drag,
  decaying,
  accretion,
  missing_keywords,
  thin_content,
}

// ── Output ─────────────────────────────────────────────────────────────────
if (JSON_MODE) {
  console.log(JSON.stringify(report, null, 2))
} else {
  printReport(report)
}

// Save to data/
try {
  writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2))
  log(`\nReport saved → ${REPORT_OUT}`)
} catch {}

// ── Auto-fix safe upgrades ─────────────────────────────────────────────────
if (FIX_MODE) {
  log('\n── Auto-fix mode ─────────────────────────────────────────────────')
  let fixed = 0

  // Update orb_class in SKILL.md for sim-promoted skills
  for (const { slug } of sim_promotions) {
    const path = join(SKILLS_DIR, slug, 'SKILL.md')
    if (!existsSync(path)) continue
    const content = readFileSync(path, 'utf8')
    if (!content.includes('orb_class: moon')) continue
    writeFileSync(path, content.replace('orb_class: moon', 'orb_class: planet'))
    log(`  ✓ promoted ${slug}: moon → planet in SKILL.md`)
    fixed++
  }

  if (fixed === 0) log('  No safe fixes to apply.')
  else log(`\n  Applied ${fixed} fix(es). Run: node scripts/release.mjs patch`)
}

// ── Watch mode (self-scheduling, no systemd) ───────────────────────────────
if (WATCH_MODE) {
  const INTERVAL_MS = 6 * 60 * 60 * 1000  // 6 hours
  log(`\n◎ Watch mode — re-auditing every 6h (Ctrl+C to stop)`)
  setInterval(async () => {
    log(`\n[${new Date().toISOString()}] Re-running audit…`)
    try {
      execSync(`node ${join(__dirname, 'audit.mjs')} --json`, {
        stdio: 'inherit', encoding: 'utf8', timeout: 120000,
      })
    } catch (e) {
      warn('Audit re-run failed:', e.message)
    }
  }, INTERVAL_MS)
}

// ── Pretty-print ───────────────────────────────────────────────────────────
function printReport(r) {
  const hr = () => log('─'.repeat(60))

  log(`Corpus: ${r.corpus_size} skills   Generated: ${r.generated_at}\n`)
  hr()

  section('PROMOTION CANDIDATES  (moon → planet)', r.promotions, s =>
    `  ${pad(s.slug,30)} planet_score=${s.planet_score}  mass=${s.mass}${s.sim_promoted ? '  ✦ sim-confirmed' : ''}`)

  section('SIM-PROMOTED  (12-step model says upgrade now)', r.sim_promotions, s =>
    `  ${pad(s.slug,30)} ${s.detail}`)

  section('COLLISION RISK  (overlap_risk > 0.35)', r.collisions, s =>
    `  ${pad(s.slug,30)} overlap=${s.overlap_risk}  class=${s.class}  parent=${s.parent||'—'}`)

  if (r.collision_clusters.length) {
    log('\nCOLLISION CLUSTERS  (≥3 siblings under same parent):')
    r.collision_clusters.forEach(c =>
      log(`  parent=${pad(c.parent,20)} children=[${c.slugs.join(', ')}]`))
    log('')
  }

  section('DEMOTION CANDIDATES  (moon → asteroid_belt)', r.demotions, s =>
    `  ${pad(s.slug,30)} belt_score=${s.asteroid_belt_score}  frag=${s.fragmentation}`)

  section('HIGH DRAG  (> 0.35)', r.high_drag.filter(s => s.drag >= 0.55), s =>
    `  ${pad(s.slug,30)} drag=${s.drag}  → ${s.suggestion}`)

  section('DECAYING  (staleness > 0.20 or health < 0.65)', r.decaying, s =>
    `  ${pad(s.slug,30)} staleness=${s.staleness}  health=${s.health}  → ${s.action}`)

  section('ACCRETION SIGNALS  (belt fragments that could merge)', r.accretion, s =>
    `  latent_parent=${pad(s.latent_parent,20)} slugs=[${s.slugs.join(', ')}]\n  → ${s.suggestion}`)

  section('MISSING KEYWORDS  (add for better routing)', r.missing_keywords, s =>
    `  ${s}`)

  section('THIN CONTENT  (< 100 words — needs expansion)', r.thin_content, s =>
    `  ${pad(s.slug,30)} ${s.words} words`)

  hr()
  log('\nSUMMARY')
  Object.entries(r.summary).forEach(([k, v]) =>
    log(`  ${pad(k,28)} ${v}`))
}

function section(title, items, fmt) {
  if (!items.length) return
  log(`\n${title}:`)
  items.forEach(i => log(fmt(i)))
  log('')
}

function pad(s, n) { return String(s).padEnd(n) }
function round(n)  { return Math.round(n * 1000) / 1000 }
