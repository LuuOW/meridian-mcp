#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT       = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS_DIR = join(ROOT, 'skills')
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

const skills = []
for (const slug of readdirSync(SKILLS_DIR).sort()) {
  const skillPath = join(SKILLS_DIR, slug, 'SKILL.md')
  try {
    const stat = statSync(skillPath)
    if (!stat.isFile()) continue
  } catch { continue }
  const md = readFileSync(skillPath, 'utf8')
  const { frontmatter, body } = parseFrontmatter(md)
  skills.push({
    slug,
    name:        frontmatter.name        || slug,
    description: frontmatter.description || '',
    orb_class:   frontmatter.orb_class   || null,
    keywords:    Array.isArray(frontmatter.keywords) ? frontmatter.keywords : [],
    body,
  })
}

mkdirSync(dirname(OUT_PATH), { recursive: true })
writeFileSync(OUT_PATH, JSON.stringify({ count: skills.length, skills }))
console.log(`[build-miniapp-index] wrote ${skills.length} skills → ${OUT_PATH}`)
