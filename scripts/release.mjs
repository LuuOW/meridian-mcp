#!/usr/bin/env node
/**
 * release.mjs — bump version, write CHANGELOG entry, commit, push, npm publish
 *
 * Usage:
 *   node scripts/release.mjs patch     # 0.2.0 → 0.2.1
 *   node scripts/release.mjs minor     # 0.2.0 → 0.3.0
 *   node scripts/release.mjs major     # 0.2.0 → 1.0.0
 *
 * What it does:
 *   1. Reads new/changed skills since last release
 *   2. Bumps package.json version
 *   3. Prepends CHANGELOG.md entry
 *   4. git add + commit + tag + push
 *   5. npm publish --access public
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath }  from 'node:url'
import { execSync }       from 'node:child_process'

const __dirname  = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT  = join(__dirname, '..')
const PKG_PATH   = join(REPO_ROOT, 'package.json')
const CLOG_PATH  = join(REPO_ROOT, 'CHANGELOG.md')
const SKILLS_DIR = join(REPO_ROOT, 'skills')

// ── Bump version ───────────────────────────────────────────────────────────
const bump = process.argv[2] || 'patch'
if (!['major', 'minor', 'patch'].includes(bump)) {
  console.error('Usage: node scripts/release.mjs [major|minor|patch]')
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'))
const [maj, min, pat] = pkg.version.split('.').map(Number)
const next = bump === 'major' ? `${maj + 1}.0.0`
           : bump === 'minor' ? `${maj}.${min + 1}.0`
           :                    `${maj}.${min}.${pat + 1}`

pkg.version = next
writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
console.log(`✓ Bumped ${pkg.version.replace(next, bump === 'patch' ? pkg.version : next)} → ${next}`)

// ── Detect new/changed skills since last tag ───────────────────────────────
let newSkills = []
let changedSkills = []
try {
  const lastTag = execSync('git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD',
    { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const diff = execSync(`git diff --name-only ${lastTag} HEAD -- skills/`,
    { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const diffLines = diff ? diff.split('\n') : []
  const slugsSeen = new Set()
  for (const line of diffLines) {
    const m = line.match(/^skills\/([^/]+)\//)
    if (m && !slugsSeen.has(m[1])) {
      slugsSeen.add(m[1])
      const tracked = execSync(`git ls-tree ${lastTag} skills/${m[1]}/SKILL.md 2>/dev/null || echo ''`,
        { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
      if (!tracked) newSkills.push(m[1])
      else changedSkills.push(m[1])
    }
  }
} catch {}

// ── Write CHANGELOG entry ──────────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10)
const lines = [`## [${next}] — ${today}`, '']

if (newSkills.length) {
  lines.push('### Added')
  newSkills.forEach(s => lines.push(`- Skill: \`${s}\``))
  lines.push('')
}
if (changedSkills.length) {
  lines.push('### Changed')
  changedSkills.forEach(s => lines.push(`- Updated skill: \`${s}\``))
  lines.push('')
}
if (!newSkills.length && !changedSkills.length) {
  lines.push('### Changed')
  lines.push('- See commit history for details.')
  lines.push('')
}

const existing = readFileSync(CLOG_PATH, 'utf8')
writeFileSync(CLOG_PATH, `# Changelog\n\n${lines.join('\n')}${existing.replace(/^# Changelog\n\n?/, '')}`)
console.log(`✓ CHANGELOG.md updated`)

// ── Git commit + tag + push ────────────────────────────────────────────────
const run = (cmd) => execSync(cmd, { cwd: REPO_ROOT, stdio: 'inherit' })

run('git add package.json CHANGELOG.md skills/ site/')
run(`git commit -m "v${next}: ${newSkills.length ? `add ${newSkills.length} skill(s)` : 'release'}\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"`)
run(`git tag v${next}`)
run('git push origin main --tags')
console.log(`✓ Pushed v${next} to GitHub`)

// ── npm publish ────────────────────────────────────────────────────────────
run('npm publish --access public')
console.log(`✓ Published meridian-skills-mcp@${next} to npm`)

// ── Deploy docs site ──────────────────────────────────────────────────────
const { copyFileSync, readdirSync } = await import('node:fs')
const SITE_SRC = join(REPO_ROOT, 'site')
const SITE_DST = '/var/www/html/docs'
for (const f of readdirSync(SITE_SRC)) {
  copyFileSync(join(SITE_SRC, f), join(SITE_DST, f))
}
console.log(`✓ Deployed site/ → ${SITE_DST}`)

console.log(`\n◎ Released v${next}`)
