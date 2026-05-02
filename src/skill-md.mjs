// Single source of truth for parsing SKILL.md files.
// Replaces the five inline regex+loop variants previously found in
// src/skills.mjs, src/embeddings.mjs, scripts/audit.mjs, scripts/fix-keywords.mjs,
// scripts/build-miniapp-index.mjs, and scripts/audit-js-orbital.mjs — each of
// which handled keyword arrays / multi-line list keywords / colon-in-value
// slightly differently, producing subtle drift.
//
// Output shape:
//   { slug, frontmatter, body, words, raw }
//
// Frontmatter parsing rules:
//   - Recognises the standard `^---\n...\n---\n` YAML-ish block.
//   - Each line must match /^[a-zA-Z_][\w-]*:\s*(.*)$/ — anything else ignored.
//   - Values that look like JSON arrays (`[a, b, "c"]`) parse to arrays;
//     single quotes are coerced to double quotes first for tolerance.
//   - Multi-line list keywords (block style):
//       keywords:
//         - alpha
//         - beta
//     parse to ['alpha','beta'].
//   - Comma-separated string keywords ("alpha, beta, gamma") split into
//     an array on the way out.
//   - Returns frontmatter={} and body=full file when no frontmatter block.

import { readFileSync, existsSync } from 'node:fs'
import { join }                     from 'node:path'

export function parseFrontmatter(md) {
  if (typeof md !== 'string') return { frontmatter: {}, body: '' }
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return { frontmatter: {}, body: md }

  const fm   = {}
  const lines = m[1].split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const km = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/)
    if (!km) continue
    const key = km[1]
    let v = km[2].trim()

    // Block-style list (key followed by indented "- item" lines)
    if (v === '' && i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
      const items = []
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        i++
        items.push(lines[i].replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, ''))
      }
      fm[key] = items
      continue
    }

    // Inline JSON array
    if (v.startsWith('[') && v.endsWith(']')) {
      try { fm[key] = JSON.parse(v.replace(/'/g, '"')); continue } catch { /* fallthrough */ }
    }

    // Strip surrounding quotes
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    fm[key] = v
  }

  return { frontmatter: fm, body: m[2].trim() }
}

// Convenience: extract a normalized keyword array regardless of source shape.
// Accepts: array → as-is; comma-string → split + trim; otherwise → [].
export function keywordsOf(frontmatter) {
  const v = frontmatter?.keywords
  if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean)
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean)
  return []
}

// Read + parse a single SKILL.md by slug. Returns null if missing.
export function readSkill(skillsDir, slug) {
  const path = join(skillsDir, slug, 'SKILL.md')
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf8')
  const { frontmatter, body } = parseFrontmatter(raw)
  return {
    slug,
    frontmatter,
    body,
    keywords: keywordsOf(frontmatter),
    words:    body.split(/\s+/).filter(Boolean).length,
    raw,
  }
}
