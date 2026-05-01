import skillsIndex from '../../_skills.json'
import { scoreSkills, jsonResponse, corsHeaders } from './_router.js'

export async function onRequest(context) {
  const { request } = context

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'POST only' }, { status: 405 })
  }

  let body
  try { body = await request.json() }
  catch { return jsonResponse({ error: 'invalid JSON body' }, { status: 400 }) }

  const task  = (body.task || '').toString().trim()
  const limit = Math.max(1, Math.min(20, parseInt(body.limit, 10) || 5))

  if (!task)             return jsonResponse({ error: 'task required'           }, { status: 400 })
  if (task.length > 800) return jsonResponse({ error: 'task too long (max 800)' }, { status: 400 })

  const ranked = scoreSkills(task, skillsIndex.skills).slice(0, limit)
  const top    = ranked[0]?.route_score || 0
  const confidence =
    top >= 40 ? 'strong' :
    top >= 15 ? 'moderate' :
    top >  0  ? 'weak' : 'none'

  return jsonResponse({
    task,
    note: 'Lexical scorer — simplified approximation of the production orbital router.',
    confidence,
    top_score: top,
    selected: ranked,
  })
}
