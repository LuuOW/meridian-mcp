#!/usr/bin/env node
// Distribution audit for the JS edge classifier.
// Loads every SKILL.md in the corpus, runs orbitalClassify against an empty
// task, and prints the resulting class distribution + a few sample classifications.
//
// Usage:
//   node scripts/audit-js-orbital.mjs           # full report
//   node scripts/audit-js-orbital.mjs --json    # machine-readable

import { readdirSync, statSync }              from 'node:fs'
import { join, dirname }                       from 'node:path'
import { fileURLToPath }                       from 'node:url'
import { orbitalClassify }                     from '../landing/functions/api/_orbital.js'
import { readSkill, keywordsOf }               from '../src/skill-md.mjs'

const __dirname  = dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = join(__dirname, '..', 'skills')
const JSON_MODE  = process.argv.includes('--json')

function parseSkill(slug) {
  const skill = readSkill(SKILLS_DIR, slug)
  if (!skill) return null
  return {
    slug,
    description: skill.frontmatter.description || '',
    keywords:    skill.keywords,
    body:        skill.body,
  }
}

const slugs = readdirSync(SKILLS_DIR).filter(name => {
  try { return statSync(join(SKILLS_DIR, name)).isDirectory() } catch { return false }
})

const skills = slugs.map(parseSkill).filter(Boolean)
const out = orbitalClassify(skills, '')

const dist = {}
const sysDist = {}
for (const r of out) {
  const c = r.classification.class
  dist[c] = (dist[c] || 0) + 1
  const sys = r.classification.star_system
  sysDist[sys] = (sysDist[sys] || 0) + 1
}

const total = out.length
const pct = (n) => `${((n/total)*100).toFixed(1)}%`

if (JSON_MODE) {
  const samples = {}
  for (const cls of ['planet','moon','trojan','asteroid','comet','irregular']) {
    samples[cls] = out.filter(r => r.classification.class === cls).slice(0, 5).map(r => r.slug)
  }
  console.log(JSON.stringify({ total, dist, sysDist, samples }, null, 2))
  process.exit(0)
}

console.log(`\nJS edge classifier — corpus of ${total} skills\n`)

console.log('CLASS DISTRIBUTION')
const order = ['planet','moon','trojan','asteroid','comet','irregular']
for (const cls of order) {
  const n = dist[cls] || 0
  const bar = '█'.repeat(Math.round((n/total) * 40))
  console.log(`  ${cls.padEnd(10)} ${String(n).padStart(3)} ${pct(n).padStart(6)}  ${bar}`)
}

console.log('\nSTAR SYSTEM DISTRIBUTION')
for (const [sys, n] of Object.entries(sysDist).sort((a,b) => b[1]-a[1])) {
  const bar = '█'.repeat(Math.round((n/total) * 40))
  console.log(`  ${sys.padEnd(10)} ${String(n).padStart(3)} ${pct(n).padStart(6)}  ${bar}`)
}

console.log('\nSAMPLES PER CLASS')
for (const cls of order) {
  const members = out.filter(r => r.classification.class === cls)
  console.log(`  ${cls} (${members.length}):`)
  for (const r of members.slice(0, 6)) {
    const p = r.classification.physics
    console.log(`    ${r.slug.padEnd(28)} m=${p.mass.toFixed(2)} s=${p.scope.toFixed(2)} i=${p.independence.toFixed(2)} dr=${p.dep_ratio.toFixed(2)} cd=${p.cross_domain.toFixed(2)} f=${p.fragmentation.toFixed(2)}`)
  }
  if (members.length > 6) console.log(`    … +${members.length-6} more`)
}
