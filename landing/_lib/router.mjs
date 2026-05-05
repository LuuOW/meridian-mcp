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
  if (!skills.length) return { task, skills: [], total: 0 }

  // The orbital classifier needs body + keywords + description per skill.
  // _skills.json from build-miniapp-index.mjs already includes those fields.
  const ranked = orbitalClassify(skills, task)
  const top = ranked.slice(0, Math.max(1, Math.min(20, limit)))

  return {
    task,
    skills: top,
    total:  ranked.length,
    classifier: 'orbital-edge-v1',
  }
}
