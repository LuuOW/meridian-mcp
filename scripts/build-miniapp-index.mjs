#!/usr/bin/env node
// Build the miniapp's skill index by merging two sources:
//   • SKILL.md files in skills/<slug>/SKILL.md  → name, description, keywords, body
//   • galaxy/skills_data.json (orbital scorer)  → class, decision_rule,
//     parent, lagrange_systems, star_system, scores
// Outputs landing/_skills.json plus an IDF table for the scorer.

import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT       = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS_DIR = join(ROOT, 'skills')
const ORBIT_DATA = join(ROOT, 'galaxy', 'skills_data.json')
const OUT_PATH   = join(ROOT, 'landing', '_skills.json')

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) return { frontmatter: {}, body: md.trim() }
  const fm = {}
  for (const line of m[1].split('\n')) {
    const km = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/)
    if (!km) continue
    let v = km[2].trim()
    if (v.startsWith('[') && v.endsWith(']')) {
      try { v = JSON.parse(v.replace(/'/g, '"')) } catch {}
    }
    fm[km[1]] = v
  }
  return { frontmatter: fm, body: m[2].trim() }
}

// Load orbital metadata if available
let orbital = {}
if (existsSync(ORBIT_DATA)) {
  try {
    const arr = JSON.parse(readFileSync(ORBIT_DATA, 'utf8'))
    for (const o of arr) orbital[o.slug] = o
  } catch (e) {
    console.warn('[build-miniapp-index] failed to read orbital data:', e.message)
  }
}

const skills = []
for (const slug of readdirSync(SKILLS_DIR).sort()) {
  const skillPath = join(SKILLS_DIR, slug, 'SKILL.md')
  try {
    const stat = statSync(skillPath)
    if (!stat.isFile()) continue
  } catch { continue }
  const md = readFileSync(skillPath, 'utf8')
  const { frontmatter, body } = parseFrontmatter(md)
  const orb = orbital[slug] || null

  skills.push({
    slug,
    name:        frontmatter.name        || slug,
    description: frontmatter.description || '',
    orb_class:   frontmatter.orb_class   || (orb && orb.class) || null,
    keywords:    Array.isArray(frontmatter.keywords) ? frontmatter.keywords : [],
    body,
    // Orbital classification metadata (drives smart scoring + side panel)
    classification: orb ? {
      class:              orb.class || null,
      decision_rule:      orb.decision_rule || null,
      parent:             orb.parent || null,
      latent_parent:      orb.latent_parent || null,
      star_system:        orb.star_system || null,
      lagrange_systems:   Array.isArray(orb.lagrange_systems) ? orb.lagrange_systems : [],
      lagrange_potential: typeof orb.lagrange_potential === 'number' ? orb.lagrange_potential : 0,
      tidal_lock:         !!orb.tidal_lock,
      habitable_zone:     !!orb.habitable_zone_stable,
      roche_disrupted:    !!orb.roche_disrupted,
      scores:             orb.scores || {},
    } : null,
  })
}

// Compute corpus-wide IDF for keywords. Lets the scorer downweight tokens
// that appear in many skills (e.g. "api", "system") and upweight rare,
// discriminating tokens (e.g. "do-calculus", "wireguard").
const STOP = new Set([
  'the','and','for','with','that','this','from','have','your','about',
  'into','what','when','where','which','their','there','these','those',
  'will','would','should','could','been','being','need','want','get',
  'set','use','using','make','made','like','also','some','any','all',
  'one','two','out','off','its',"it's",'you',"you're",'our',
])
function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOP.has(t))
}

const docFreq = new Map()
const N = skills.length
for (const s of skills) {
  const toks = new Set([
    ...tokenize(s.description),
    ...(s.keywords || []).flatMap(k => tokenize(k)),
  ])
  for (const t of toks) docFreq.set(t, (docFreq.get(t) || 0) + 1)
}

// IDF = log( (N + 1) / (df + 1) ) + 1   — smoothed
const idf = {}
for (const [t, df] of docFreq) {
  idf[t] = Math.log((N + 1) / (df + 1)) + 1
}

mkdirSync(dirname(OUT_PATH), { recursive: true })
writeFileSync(OUT_PATH, JSON.stringify({
  count: skills.length,
  built_at: new Date().toISOString(),
  idf,
  skills,
}))
console.log(`[build-miniapp-index] wrote ${skills.length} skills (${Object.keys(idf).length} IDF terms) → ${OUT_PATH}`)
