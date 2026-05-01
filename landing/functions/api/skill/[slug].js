import skillsIndex from '../../../_skills.json'
import { jsonResponse, corsHeaders } from '../_router.js'

export async function onRequest({ request, params }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() })
  if (request.method !== 'GET')     return jsonResponse({ error: 'GET only' }, { status: 405 })

  const slug = (params.slug || '').toString()
  const skill = skillsIndex.skills.find(s => s.slug === slug)

  if (!skill) return jsonResponse({ error: `unknown skill: ${slug}` }, { status: 404 })
  return jsonResponse(skill)
}
