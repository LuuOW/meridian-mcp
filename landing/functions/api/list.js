import skillsIndex from '../../_skills.json'
import { jsonResponse, corsHeaders } from './_router.js'

export async function onRequest({ request }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() })
  if (request.method !== 'GET')     return jsonResponse({ error: 'GET only' }, { status: 405 })

  return jsonResponse({
    count:  skillsIndex.count,
    skills: skillsIndex.skills.map(s => ({
      slug:        s.slug,
      name:        s.name,
      description: s.description,
      orb_class:   s.orb_class,
    })),
  })
}
