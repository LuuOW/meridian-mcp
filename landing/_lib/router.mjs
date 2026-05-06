// Edge router — runs in browser AND node. Loads _skills.json (curated +
// pre-classified corpus), runs the orbital classifier against the task,
// returns top-K. No backend.
//
// Optional LLM enhancement is in api.js (browser GH Models client). The
// router itself never makes a network call.

import { orbitalClassify } from './orbital.mjs'

let _skillsPromise = null

export async function loadSkills(url = '/_skills.json') {
  if (_skillsPromise) return _skillsPromise
  _skillsPromise = fetch(url, { cache: 'force-cache' })
    .then(r => {
      if (!r.ok) throw new Error(`_skills.json HTTP ${r.status}`)
      return r.json()
    })
    .then(j => Array.isArray(j.skills) ? j.skills : (Array.isArray(j) ? j : []))
  return _skillsPromise
}

// Set the corpus directly (Node callers, lens cross-origin import path).
export function setSkills(arr) {
  _skillsPromise = Promise.resolve(arr)
}

export async function route({ task, limit = 5, skillsUrl } = {}) {
  if (!task || typeof task !== 'string') throw new Error('task required')
  const skills = await loadSkills(skillsUrl)
  if (!skills.length) {
    return { task, skills: [], total: 0, top_score: 0, confidence: 'low',
             candidates_generated: 0, classifier: 'orbital-edge-v1' }
  }

  const ranked = orbitalClassify(skills, task)
  const top = ranked.slice(0, Math.max(1, Math.min(20, limit)))
  const top_score = top[0]?.route_score || 0
  // Confidence band tuned to the orbital scorer's typical scale (~0–200+).
  // Above 30 the top match has clear keyword + description overlap; below
  // 8 it's mostly noise. Same shape the old API exposed for UI styling.
  const confidence = top_score >= 30 ? 'high' : top_score >= 8 ? 'medium' : 'low'

  return {
    task,
    skills:               top,
    total:                ranked.length,
    top_score,
    confidence,
    candidates_generated: ranked.length,
    classifier:           'orbital-edge-v1',
  }
}
