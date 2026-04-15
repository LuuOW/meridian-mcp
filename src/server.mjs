// server.mjs — HTTP MCP + Stripe checkout/webhook routes.
// Listens on localhost:8002; nginx proxies public paths to here.
import express                         from 'express'
import { Server }                      from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  routeTask, getSkill, searchSkills, listSkillsFromDisk,
} from './skills.mjs'
import { validateAndTouch, createKey, pendingStore, pendingClaim } from './keystore.mjs'
import { createCheckoutSession, verifyWebhook, PLAN_QUOTAS } from './stripe-helper.mjs'
import {
  verifyWorldProof, issueSession, getSession, incrementUsage,
  summarizeQuota, answerQuery,
} from './miniapp.mjs'

const PORT                   = parseInt(process.env.MERIDIAN_MCP_PORT || '8002', 10)
const STRIPE_WEBHOOK_SECRET  = process.env.STRIPE_WEBHOOK_SECRET || ''
const PUBLIC_ORIGIN          = process.env.MERIDIAN_ORIGIN || 'https://ask-meridian.uk'

// ── Build a fresh MCP server per request (stateless mode) ────────────────────
function makeServer() {
  const server = new Server(
    { name: 'meridian-skills', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'route_task',    description: 'Route a task to relevant skills via orbital routing.',
        inputSchema: { type:'object', properties:{ task:{type:'string'}, limit:{type:'integer',default:5} }, required:['task'] }},
      { name: 'get_skill',     description: 'Fetch full SKILL.md content for a skill slug.',
        inputSchema: { type:'object', properties:{ slug:{type:'string'} }, required:['slug'] }},
      { name: 'list_skills',   description: 'List all available skill slugs.',
        inputSchema: { type:'object', properties:{} }},
      { name: 'search_skills', description: 'Full-text search across skill names, descriptions, bodies.',
        inputSchema: { type:'object', properties:{ query:{type:'string'} }, required:['query'] }},
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    try {
      let result
      switch (name) {
        case 'route_task':    result = await routeTask(args.task, args.limit ?? 5); break
        case 'get_skill':     result = getSkill(args.slug); break
        case 'list_skills':   result = { skills: listSkillsFromDisk() }; break
        case 'search_skills': result = { query: args.query, hits: searchSkills(args.query) }; break
        default: throw new Error(`Unknown tool: ${name}`)
      }
      return { content: [{ type:'text', text: JSON.stringify(result, null, 2) }] }
    } catch (e) {
      return { content: [{ type:'text', text: `Error: ${e.message}` }], isError: true }
    }
  })

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: listSkillsFromDisk().map(slug => ({
      uri: `meridian://skills/${slug}`, name: slug, description: `Skill: ${slug}`, mimeType: 'text/markdown',
    })),
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const m = req.params.uri.match(/^meridian:\/\/skills\/([a-z0-9_-]+)$/i)
    if (!m) throw new Error(`Invalid resource URI: ${req.params.uri}`)
    const { body, frontmatter } = getSkill(m[1])
    const text = `---\nname: ${frontmatter.name || m[1]}\ndescription: ${frontmatter.description || ''}\n---\n\n${body}`
    return { contents: [{ uri: req.params.uri, mimeType: 'text/markdown', text }] }
  })

  return server
}

// ── Express app ─────────────────────────────────────────────────────────────
const app = express()

// Request logging (non-health)
app.use((req, _res, next) => {
  if (req.path !== '/health') console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`)
  next()
})

app.get('/health', (_req, res) =>
  res.json({ ok: true, service: 'meridian-mcp', skills: listSkillsFromDisk().length })
)

// ── WEBHOOK — must be mounted BEFORE express.json() so we get the raw body ──
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!STRIPE_WEBHOOK_SECRET) {
    console.warn('webhook received but STRIPE_WEBHOOK_SECRET not set — ignoring')
    return res.status(503).send('webhook secret not configured')
  }
  const signature = req.headers['stripe-signature']
  let event
  try {
    event = verifyWebhook({
      rawBody: req.body, signature, webhookSecret: STRIPE_WEBHOOK_SECRET,
    })
  } catch (e) {
    console.error('webhook verify failed:', e.message)
    return res.status(400).send(`invalid signature: ${e.message}`)
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        const plan = session.metadata?.meridian_plan || 'pro'
        const monthly_limit = PLAN_QUOTAS[plan] || 10_000
        const { key } = createKey({
          stripe_customer_id: session.customer,
          plan,
          monthly_limit,
        })
        pendingStore(session.id, key)
        console.log(`[webhook] provisioned ${plan} key for customer=${session.customer} session=${session.id}`)
        break
      }
      case 'customer.subscription.deleted': {
        // TODO: revoke keys for this customer
        const sub = event.data.object
        console.log(`[webhook] subscription canceled for customer=${sub.customer} — keys should be revoked`)
        break
      }
      default:
        // no-op for invoice.paid, invoice.payment_failed, etc.
        break
    }
  } catch (e) {
    console.error(`webhook handler for ${event.type} threw:`, e)
    // Still return 200 — Stripe will retry on non-2xx, but our key-creation error shouldn't spam retries
  }

  res.json({ received: true, type: event.type })
})

// ── ALL OTHER ROUTES get JSON body parser ──────────────────────────────────
app.use(express.json({ limit: '1mb' }))

// Create a Checkout Session
app.post('/checkout', async (req, res) => {
  try {
    const plan = req.body?.plan || req.query.plan || 'pro'
    if (!['pro', 'team'].includes(plan)) return res.status(400).json({ error: 'invalid plan' })
    const { url, session_id } = await createCheckoutSession({
      plan,
      successUrl: `${PUBLIC_ORIGIN}/checkout/success.html`,
      cancelUrl:  `${PUBLIC_ORIGIN}/checkout/cancel.html`,
    })
    res.json({ url, session_id })
  } catch (e) {
    console.error('checkout err:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Claim the API key after Stripe redirects back (one-shot, 15 min TTL)
app.get('/checkout/claim', (req, res) => {
  const sid = req.query.session_id
  if (!sid || typeof sid !== 'string') return res.status(400).json({ error: 'session_id required' })
  const rawKey = pendingClaim(sid)
  if (!rawKey) return res.status(404).json({ error: 'no key available (expired or already claimed)' })
  res.json({ api_key: rawKey })
})

// ── Mini App endpoints (World ID verified, session-tokened) ─────────────────
// Verify a MiniKit proof → issue a session token + quota
app.post('/miniapp/verify', async (req, res) => {
  try {
    const { payload, action, app_id } = req.body || {}
    const result = await verifyWorldProof({ payload, action, signal: '', appIdFromClient: app_id })
    const level = result.verification_level || 'device'
    const { token, session } = issueSession({
      nullifier_hash: payload.nullifier_hash,
      level,
    })
    res.json({
      verified:      true,
      level,
      nullifier:     payload.nullifier_hash.slice(0, 10) + '…',  // not the full one
      quota:         summarizeQuota(session),
      session_token: token,
    })
  } catch (e) {
    console.error('miniapp verify failed:', e.message)
    res.status(400).json({ error: e.message })
  }
})

// Check session validity + current quota
app.get('/miniapp/session', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const session = getSession(token)
  if (!session) return res.status(401).json({ error: 'session not found or expired' })
  res.json({ level: session.level, quota: summarizeQuota(session) })
})

// Ask — gated by World ID session
app.post('/miniapp/ask', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const session = getSession(token)
    if (!session) return res.status(401).json({ error: 'verify with World ID first' })

    const q = summarizeQuota(session)
    if (!q.unlimited && q.used >= q.limit) {
      return res.status(429).json({
        error: `daily quota reached (${q.used}/${q.limit}). Upgrade with Orb verification for unlimited.`,
        quota: q,
      })
    }
    const task  = String(req.body?.task || '').trim()
    const limit = Math.min(10, Math.max(1, parseInt(req.body?.limit) || 5))
    if (!task) return res.status(400).json({ error: 'task required' })

    const result = await answerQuery(task, limit)
    const updated = incrementUsage(session.hash)
    res.json({
      task:     result.task,
      selected: result.selected,
      quota:    summarizeQuota(updated),
    })
  } catch (e) {
    console.error('miniapp ask failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── Auth middleware for /mcp ────────────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization || ''
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Missing Bearer token. Get one at https://ask-meridian.uk' },
      id: null,
    })
  }
  const key = header.slice(7).trim()
  const record = validateAndTouch(key)
  if (!record) {
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32002, message: 'Invalid, revoked, or quota-exceeded API key.' },
      id: null,
    })
  }
  req.meridianKey = record
  res.setHeader('X-Meridian-Calls-Remaining', Math.max(0, record.monthly_limit - record.calls_this_month))
  next()
}

app.post('/mcp', auth, async (req, res) => {
  try {
    const mcp = makeServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => { try { transport.close?.(); mcp.close?.() } catch {} })
    await mcp.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (e) {
    console.error('MCP error:', e)
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error: ' + e.message }, id: null })
    }
  }
})
app.get('/mcp',    auth, (_req, res) => res.status(405).json({ error: 'GET not supported (stateless mode)' }))
app.delete('/mcp', auth, (_req, res) => res.status(405).json({ error: 'DELETE not supported (stateless mode)' }))

app.listen(PORT, '127.0.0.1', () => {
  console.log(`meridian-mcp listening on 127.0.0.1:${PORT} | webhook=${STRIPE_WEBHOOK_SECRET ? 'configured' : 'NOT CONFIGURED'}`)
})
