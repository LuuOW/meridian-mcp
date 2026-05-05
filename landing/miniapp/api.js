// Skill router client. Used by miniapp/app.js and vision-lab/lab.js.
//
// Previously POSTed to /api/orbital-route (Cloudflare Pages Function).
// That endpoint is gone; routing now runs entirely in the browser via
// _lib/router.mjs against the static _skills.json corpus. Signatures are
// preserved so callers don't change.

import { route } from '../_lib/router.mjs'

// Corpus URL relative to this file's location, so the same code works on
// a custom domain or a /<repo>/ subpath.
const SKILLS_URL = new URL('../_skills.json', import.meta.url).href

export async function routeTask({ task, limit = 5 }) {
  return route({ task, limit, skillsUrl: SKILLS_URL })
}

// Streaming variant. The local router is synchronous, so we fire callbacks
// once (onProgress at start, onSkill per ranked result) and return the
// summary. Same surface as the old SSE pass-through.
export async function routeTaskStream(
  { task, limit = 5 },
  { onProgress = () => {}, onSkill = () => {} } = {},
) {
  onProgress({ stage: 'route', message: 'classifying against curated corpus' })
  const result = await route({ task, limit, skillsUrl: SKILLS_URL })
  for (const s of result.skills) onSkill(s)
  onProgress({ stage: 'done', count: result.skills.length })
  return result
}
