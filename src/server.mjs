// server.mjs — HTTP MCP + Stripe checkout/webhook routes.
// Listens on localhost:8002; nginx proxies public paths to here.
import express                         from 'express'
import { randomBytes }                 from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname }               from 'node:path'
import { fileURLToPath }               from 'node:url'
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server'

const __dirname_server = dirname(fileURLToPath(import.meta.url))
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
  verifyWorldProof, issueSession, issueGuestSession, getSession, incrementUsage,
  summarizeQuota, summarizeQuotaWithPremium, answerQuery,
  beginPayment, completePayment, isPremium,
  getSkillDetail,
} from './miniapp.mjs'
import {
  beginStake, completeStake, getPositions, getMarketStatus,
  checkAndSettle, broadcastSettlement, getLeaderboard, getStakerPicks,
} from './market.mjs'

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

app.get('/health', (_req, res) => {
  let manifest = null
  try {
    const path = (process.env.MERIDIAN_SKILLS_ROOT || '/opt/skills') + '/skills_manifest.json'
    manifest = JSON.parse(readFileSync(path, 'utf8'))
  } catch {}
  res.json({
    ok: true,
    service: 'meridian-mcp',
    skills:  listSkillsFromDisk().length,
    skills_version: manifest?.version      || null,
    engine_hash:    manifest?.engine_hash  || null,
    corpus_hash:    manifest?.corpus_hash  || null,
  })
})

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
      quota:         summarizeQuotaWithPremium(session),
      session_token: token,
    })
  } catch (e) {
    console.error('miniapp verify failed:', e.message)
    res.status(400).json({ error: e.message })
  }
})

// Dev bypass — issues a real device-level session without a World ID proof.
// Protected by DEV_VERIFY_TOKEN. Never enabled in production without the token.
const DEV_VERIFY_TOKEN = process.env.DEV_VERIFY_TOKEN || ''
app.post('/miniapp/dev-verify', (req, res) => {
  if (!DEV_VERIFY_TOKEN) return res.status(404).json({ error: 'not found' })
  const { token: bodyToken } = req.body || {}
  if (!bodyToken || bodyToken !== DEV_VERIFY_TOKEN)
    return res.status(401).json({ error: 'invalid token' })
  const { token, session } = issueSession({
    nullifier_hash: 'dev:' + randomBytes(8).toString('hex'),
    level: 'device',
  })
  console.log('[dev-verify] issued device session (bypass)')
  res.json({
    verified:      true,
    level:         'device',
    quota:         summarizeQuota(session),
    session_token: token,
  })
})

// Guest sign-in — no World ID required, 5 queries/day, no real staking payouts
app.post('/miniapp/guest', (req, res) => {
  try {
    // Fingerprint: hash of user-agent + a client-supplied nonce (no PII stored)
    const ua = req.headers['user-agent'] || ''
    const nonce = (req.body || {}).nonce || ''
    const fingerprint = ua + ':' + nonce
    const { token, session } = issueGuestSession({ fingerprint })
    res.json({
      verified:      true,
      level:         'guest',
      quota:         summarizeQuota(session),
      session_token: token,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Check session validity + current quota
app.get('/miniapp/session', (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const session = getSession(token)
  if (!session) return res.status(401).json({ error: 'session not found or expired' })
  res.json({ level: session.level, quota: summarizeQuotaWithPremium(session) })
})

// Skill detail — SKILL.md body + physics props (gated by World ID session)
app.get('/miniapp/skill/:slug', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const session = getSession(token)
    if (!session) return res.status(401).json({ error: 'verify with World ID first' })
    const detail = getSkillDetail(req.params.slug)
    res.json(detail)
  } catch (e) {
    console.error('skill detail failed:', e.message)
    res.status(404).json({ error: e.message })
  }
})

// ── Premium upgrade via WLD payment ───────────────────────────────────────
app.post('/miniapp/upgrade/begin', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const session = getSession(token)
    if (!session) return res.status(401).json({ error: 'verify with World ID first' })
    if (isPremium(session)) return res.status(400).json({ error: 'already premium' })
    res.json(beginPayment({ session_hash: session.hash }))
  } catch (e) {
    console.error('upgrade begin failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.post('/miniapp/upgrade/complete', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const session = getSession(token)
    if (!session) return res.status(401).json({ error: 'verify with World ID first' })
    const { reference, transaction_id, app_id } = req.body || {}
    if (!reference || !transaction_id) return res.status(400).json({ error: 'reference and transaction_id required' })

    await completePayment({
      session_hash: session.hash,
      reference,
      transaction_id,
      app_id: app_id || process.env.WORLD_APP_ID_STAGING || process.env.WORLD_APP_ID_PROD,
    })
    // Re-fetch the updated session to get premium flag
    const updated = getSession(token)
    res.json({
      premium: isPremium(updated),
      quota:   summarizeQuotaWithPremium(updated),
    })
  } catch (e) {
    console.error('upgrade complete failed:', e.message)
    res.status(400).json({ error: e.message })
  }
})

// Ask — gated by World ID session
app.post('/miniapp/ask', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const session = getSession(token)
    if (!session) return res.status(401).json({ error: 'verify with World ID first' })

    const q = summarizeQuotaWithPremium(session)
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
    const quota   = summarizeQuotaWithPremium(updated)
    const resetAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    res.setHeader('X-Meridian-Reset-At', resetAt)
    res.json({
      task:            result.task,
      selected:        result.selected,
      confidence:      result.confidence      || 'moderate',
      top_score:       result.top_primary_score ?? null,
      quota,
    })
  } catch (e) {
    console.error('miniapp ask failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── Public /public/skill/:slug — real skill data, no auth required ────────
// Skill bodies are markdown files — not sensitive. Auth is only for AI routing.
app.get('/public/skill/:slug', async (req, res) => {
  try {
    const detail = getSkillDetail(req.params.slug)
    res.json(detail)
  } catch (e) {
    res.status(404).json({ error: e.message })
  }
})

// ── Public /market/today — arXiv papers + live stake pool data ───────────
const DAILY_PAPERS_FILE = join(__dirname_server, '..', 'data', 'daily_papers.json')

app.get('/market/today', (req, res) => {
  try {
    if (!existsSync(DAILY_PAPERS_FILE)) {
      return res.status(503).json({ error: 'Daily papers not yet generated. Run paper_orbit.py.' })
    }
    const data   = JSON.parse(readFileSync(DAILY_PAPERS_FILE, 'utf8'))
    const date   = data.date

    // Merge live stake pool totals into paper records
    const status = getMarketStatus(date)
    const poolByPaper = {}
    for (const p of (status.papers || [])) poolByPaper[p.arxiv_id] = p

    // Determine calling user's session (optional — unauthenticated is fine)
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const session = token ? getSession(token) : null

    const papers = (data.papers || []).map(p => ({
      ...p,
      stake_pool_wld: poolByPaper[p.arxiv_id]?.total_staked_wld || 0,
      stake_count:    poolByPaper[p.arxiv_id]?.stake_count       || 0,
      your_stake_wld: 0,   // filled below if session present
    }))

    // Annotate with user's own stakes if authenticated
    if (session) {
      const userPositions = getPositions(session.hash).filter(p => p.date === date)
      const userByPaper   = {}
      for (const p of userPositions) userByPaper[p.arxiv_id] = (userByPaper[p.arxiv_id] || 0) + p.amount_wld
      for (const p of papers) p.your_stake_wld = parseFloat((userByPaper[p.arxiv_id] || 0).toFixed(4))
    }

    res.json({
      date,
      paper_count:     papers.length,
      total_pool_wld:  status.total_pool_wld,
      settles_at:      status.settles_at,
      settlement:      status.settlement,
      papers,
    })
  } catch (e) {
    console.error('market/today error:', e)
    res.status(500).json({ error: e.message })
  }
})

// ── Public /market/status/:date — pool totals for any date ───────────────
app.get('/market/status/:date', (req, res) => {
  const d = req.params.date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: 'invalid date (YYYY-MM-DD)' })
  try {
    res.json(getMarketStatus(d))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Stake endpoints — World ID session required ───────────────────────────
app.post('/market/stake/begin', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const session = getSession(token)
    if (!session) return res.status(401).json({ error: 'verify with World ID first' })

    const { arxiv_id, paper_title, paper_class, payout_multiplier, amount_wld, date } = req.body || {}
    if (!arxiv_id) return res.status(400).json({ error: 'arxiv_id required' })

    const intent = beginStake({
      session_hash:      session.hash,
      arxiv_id,
      paper_title,
      paper_class,
      payout_multiplier,
      amount_wld,
      date,
    })
    res.json(intent)
  } catch (e) {
    console.error('stake begin failed:', e.message)
    res.status(400).json({ error: e.message })
  }
})

app.post('/market/stake/complete', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const session = getSession(token)
    if (!session) return res.status(401).json({ error: 'verify with World ID first' })

    const { reference, transaction_id, app_id, stake_date } = req.body || {}
    if (!reference || !transaction_id) {
      return res.status(400).json({ error: 'reference and transaction_id required' })
    }

    const pos = await completeStake({
      reference,
      transaction_id,
      app_id: app_id || process.env.WORLD_APP_ID_STAGING || process.env.WORLD_APP_ID_PROD,
      stake_date,  // passed from frontend — avoids midnight date mismatch
    })
    res.json({ ok: true, stake: pos })
  } catch (e) {
    console.error('stake complete failed:', e.message)
    res.status(400).json({ error: e.message })
  }
})

// ── Leaderboard — public ──────────────────────────────────────────────────
app.get('/market/leaderboard', (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50))
    const rows  = getLeaderboard({ limit })
    res.json({ count: rows.length, leaderboard: rows })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Leaderboard staker drill-down — public ────────────────────────────────
app.get('/market/leaderboard/:address/stakes', (req, res) => {
  try {
    const addr = req.params.address.toLowerCase()
    if (!/^0x[0-9a-f]{40}$/i.test(addr)) return res.status(400).json({ error: 'invalid address' })
    const stakes = getStakerPicks(addr)
    res.json({ address: addr, picks: stakes })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Positions — session-gated ──────────────────────────────────────────────
app.get('/market/positions', (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const session = getSession(token)
    if (!session) return res.status(401).json({ error: 'verify with World ID first' })
    res.json({ positions: getPositions(session.hash) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Settlement — admin-only ────────────────────────────────────────────────
app.post('/market/settle/:date', async (req, res) => {
  const adminKey = process.env.MERIDIAN_ADMIN_KEY
  if (!adminKey) return res.status(503).json({ error: 'MERIDIAN_ADMIN_KEY not configured' })
  const provided = (req.headers['x-meridian-admin'] || '').trim()
  if (provided !== adminKey) return res.status(403).json({ error: 'forbidden' })

  const d = req.params.date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: 'invalid date' })

  try {
    const result = await checkAndSettle(d)
    // Attempt on-chain broadcast immediately
    let onchain = null
    try { onchain = await broadcastSettlement(d) } catch (e) {
      console.warn(`[settle] on-chain broadcast failed: ${e.message}`)
    }
    res.json({ date: d, settlement: result, onchain })
  } catch (e) {
    console.error('settle failed:', e.message)
    res.status(400).json({ error: e.message })
  }
})

// ── Public /route — no auth, returns top-K slugs + scores only ───────────
app.get('/route', async (req, res) => {
  try {
    const task  = String(req.query.task || '').trim()
    const limit = Math.min(10, Math.max(1, parseInt(req.query.limit) || 5))
    if (!task) return res.status(400).json({ error: 'task required' })
    const result = await answerQuery(task, limit)
    res.json({
      task:       result.task,
      confidence: result.confidence || 'moderate',
      top_score:  result.top_primary_score ?? null,
      skills:     (result.selected || []).map(s => ({
        slug: s.slug, class: s.class, route_score: s.route_score,
      })),
    })
  } catch (e) {
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

// ── Secrets vault API ─────────────────────────────────────────────────────
const SECRETS_TOKEN = process.env.SECRETS_TOKEN || ''
const VAULT_PATH    = '/opt/meridian-vault/.env'

function authVault(req, res) {
  const tok = (req.headers.authorization || '').replace('Bearer ', '').trim()
  if (!SECRETS_TOKEN || tok !== SECRETS_TOKEN) {
    res.status(401).json({ error: 'unauthorized' }); return true
  }
  return false
}

function parseVault() {
  const raw = readFileSync(VAULT_PATH, 'utf8')
  const entries = []
  let src = 'core'
  for (const line of raw.split('\n')) {
    const t = line.trim()
    const m = t.match(/^#\s*──\s*(.+?)\s*──/)
    if (m) { src = m[1]; continue }
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    entries.push({ key: t.slice(0, eq).trim(), value: t.slice(eq + 1).trim(), source: src })
  }
  return entries
}

app.get('/secrets/keys', (req, res) => {
  if (authVault(req, res)) return
  res.json(parseVault().map(({ key, source }) => ({ key, source })))
})

app.get('/secrets/value/:key', (req, res) => {
  if (authVault(req, res)) return
  const entry = parseVault().find(e => e.key === req.params.key)
  if (!entry) return res.status(404).json({ error: 'not found' })
  res.json(entry)
})

app.post('/secrets/set', (req, res) => {
  if (authVault(req, res)) return
  const { key, value } = req.body || {}
  if (!key || value === undefined) return res.status(400).json({ error: 'key and value required' })
  const raw = readFileSync(VAULT_PATH, 'utf8')
  const re  = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*$`, 'm')
  const updated = re.test(raw) ? raw.replace(re, `${key}=${value}`) : raw.trimEnd() + `\n${key}=${value}\n`
  writeFileSync(VAULT_PATH, updated)
  res.json({ ok: true })
})

app.post('/secrets/delete', (req, res) => {
  if (authVault(req, res)) return
  const { key } = req.body || {}
  if (!key) return res.status(400).json({ error: 'key required' })
  const raw = readFileSync(VAULT_PATH, 'utf8')
  const re  = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*\n?`, 'm')
  if (!re.test(raw)) return res.status(404).json({ error: 'not found' })
  writeFileSync(VAULT_PATH, raw.replace(re, ''))
  res.json({ ok: true })
})

// ── Passkeys (WebAuthn) ───────────────────────────────────────────────────
const PASSKEYS_FILE = '/root/.vault-passkeys.json'
const RP_ID         = 'secrets.ask-meridian.uk'
const RP_NAME       = 'Meridian Vault'
const WA_ORIGIN     = 'https://secrets.ask-meridian.uk'

function loadPK() {
  try { if (existsSync(PASSKEYS_FILE)) return JSON.parse(readFileSync(PASSKEYS_FILE, 'utf8')) } catch {}
  return { credentials: [], challenge: null }
}
function savePK(d) { writeFileSync(PASSKEYS_FILE, JSON.stringify(d, null, 2)) }

// List registered passkeys (token-protected)
app.get('/secrets/passkey/list', (req, res) => {
  if (authVault(req, res)) return
  const { credentials } = loadPK()
  res.json(credentials.map(({ id, name, deviceType, backedUp, createdAt }) =>
    ({ id, name, deviceType, backedUp, createdAt })))
})

// Generate registration options (token-protected — only authed user can add passkeys)
app.get('/secrets/passkey/register-options', async (req, res) => {
  if (authVault(req, res)) return
  const pk = loadPK()
  const options = await generateRegistrationOptions({
    rpName: RP_NAME, rpID: RP_ID,
    userName: 'vault-owner', userDisplayName: 'Vault Owner',
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    excludeCredentials: pk.credentials.map(c => ({ id: c.id, type: 'public-key' })),
  })
  pk.challenge = options.challenge
  savePK(pk)
  res.json(options)
})

// Verify registration + store credential (token-protected)
app.post('/secrets/passkey/register-verify', async (req, res) => {
  if (authVault(req, res)) return
  const pk = loadPK()
  try {
    const { verified, registrationInfo } = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: pk.challenge,
      expectedOrigin: WA_ORIGIN,
      expectedRPID: RP_ID,
    })
    if (!verified) return res.status(400).json({ error: 'verification failed' })
    const { credential, credentialDeviceType, credentialBackedUp } = registrationInfo
    pk.credentials.push({
      id:         credential.id,
      publicKey:  Buffer.from(credential.publicKey).toString('base64'),
      counter:    credential.counter,
      deviceType: credentialDeviceType,
      backedUp:   credentialBackedUp,
      name:       req.body.deviceName || 'Passkey',
      createdAt:  new Date().toISOString(),
    })
    pk.challenge = null
    savePK(pk)
    res.json({ verified: true })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

// Generate auth options (public — starts the login flow)
app.get('/secrets/passkey/auth-options', async (req, res) => {
  const pk = loadPK()
  if (!pk.credentials.length) return res.status(404).json({ error: 'no passkeys registered' })
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'preferred',
    allowCredentials: pk.credentials.map(c => ({ id: c.id, type: 'public-key' })),
  })
  pk.challenge = options.challenge
  savePK(pk)
  res.json(options)
})

// Verify authentication (public — returns SECRETS_TOKEN on success)
app.post('/secrets/passkey/auth-verify', async (req, res) => {
  const pk   = loadPK()
  const cred = pk.credentials.find(c => c.id === req.body.id)
  if (!cred) return res.status(404).json({ error: 'credential not found' })
  try {
    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge: pk.challenge,
      expectedOrigin: WA_ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id:        cred.id,
        publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64')),
        counter:   cred.counter,
      },
    })
    if (!verified) return res.status(400).json({ error: 'verification failed' })
    cred.counter  = authenticationInfo.newCounter
    pk.challenge  = null
    savePK(pk)
    res.json({ verified: true, token: SECRETS_TOKEN })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

// Delete a passkey (token-protected)
app.post('/secrets/passkey/delete', (req, res) => {
  if (authVault(req, res)) return
  const { id } = req.body || {}
  const pk = loadPK()
  pk.credentials = pk.credentials.filter(c => c.id !== id)
  savePK(pk)
  res.json({ ok: true })
})

app.listen(PORT, '127.0.0.1', () => {
  console.log(`meridian-mcp listening on 127.0.0.1:${PORT} | webhook=${STRIPE_WEBHOOK_SECRET ? 'configured' : 'NOT CONFIGURED'}`)
})

// ── Daily paper pipeline scheduler ───────────────────────────────────────
// Runs at 10:00 UTC. Calls papers/pipeline.py then papers/paper_orbit.py.
import { execFile } from 'node:child_process'
;(function schedulePapers() {
  const VENV_PY    = '/opt/meridian-mcp/papers/venv/bin/python3'
  const PAPERS_DIR = join(__dirname_server, '..', 'papers')

  function msUntilNext1000UTC() {
    const now  = new Date()
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10, 0, 0, 0))
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1)
    return next - now
  }

  function runPy(script) {
    return new Promise((resolve, reject) => {
      execFile(VENV_PY, [join(PAPERS_DIR, script)], { cwd: PAPERS_DIR, timeout: 180_000 },
        (err, stdout, stderr) => {
          if (stdout) console.log(`[papers] ${script}:`, stdout.trim().slice(0, 300))
          if (stderr) console.warn(`[papers] ${script} stderr:`, stderr.trim().slice(0, 200))
          err ? reject(err) : resolve()
        })
    })
  }

  async function runPipeline() {
    console.log(`[papers] daily run — ${new Date().toISOString()}`)
    try {
      await runPy('pipeline.py')
      await runPy('paper_orbit.py')
      console.log('[papers] ✓ daily_papers.json refreshed')
      await runPy('synthesize_skill.py')
      console.log('[papers] ✓ daily skill synthesized')
    } catch (e) {
      console.error('[papers] pipeline failed:', e.message)
    } finally {
      setTimeout(runPipeline, msUntilNext1000UTC())
    }
  }

  const ms = msUntilNext1000UTC()
  console.log(`[papers] scheduler armed — first run in ${Math.round(ms / 60000)}min (10:00 UTC)`)
  setTimeout(runPipeline, ms)
})()

// ── In-process settlement scheduler ──────────────────────────────────────
// Runs daily at 10:15 UTC. Lives and dies with this process — no OS cron.
;(function scheduleSettlement() {
  function msUntilNext1015UTC() {
    const now  = new Date()
    const next = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10, 15, 0, 0
    ))
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1)
    return next - now
  }

  async function runSettlement() {
    const today = new Date().toISOString().slice(0, 10)
    console.log(`[settle] daily run triggered — ${today}`)
    try {
      const { readFileSync, existsSync } = await import('node:fs')
      const { join, dirname }            = await import('node:path')
      const { fileURLToPath }            = await import('node:url')
      const __dir   = dirname(fileURLToPath(import.meta.url))
      const sFile   = join(__dir, '..', 'data', 'stakes.json')
      if (!existsSync(sFile)) { console.log('[settle] no stakes.json yet'); return }

      const stakes  = JSON.parse(readFileSync(sFile, 'utf8'))
      const due     = Object.entries(stakes).filter(([date, day]) => {
        if (day.settlement) return false
        if (day.settles_at > today) return false
        return day.positions.some(p => p.status === 'active')
      })
      if (!due.length) { console.log('[settle] nothing due'); return }

      for (const [date] of due) {
        console.log(`[settle] settling ${date}`)
        try {
          const result = await checkAndSettle(date)
          console.log(`[settle] ${date} off-chain done — pool: ${result.total_pool_wld} WLD | winners: ${result.winner_paper_count} | no_winners: ${result.no_winners}`)
          // Broadcast payouts on-chain if there are positions with wallet addresses
          try {
            const onchain = await broadcastSettlement(date)
            console.log(`[settle] ${date} on-chain tx: ${onchain.tx} | block: ${onchain.block} | paid: ${onchain.recipients}`)
          } catch (e) {
            console.warn(`[settle] ${date} on-chain broadcast failed (will retry manually): ${e.message}`)
          }
        } catch (e) {
          console.error(`[settle] ${date} failed:`, e.message)
        }
      }
    } catch (e) {
      console.error('[settle] scheduler error:', e.message)
    } finally {
      // Always reschedule for the next day, even if this run errored
      setTimeout(() => { runSettlement().then(scheduleNext).catch(e => { console.error('[settle] unhandled:', e.message); scheduleNext() }) }, msUntilNext1015UTC())
    }
  }

  function scheduleNext() {
    const ms = msUntilNext1015UTC()
    console.log(`[settle] next run in ${Math.round(ms / 60000)}min`)
    setTimeout(runSettlement, ms)
  }

  // Boot: schedule first run
  const ms = msUntilNext1015UTC()
  console.log(`[settle] scheduler armed — first run in ${Math.round(ms / 60000)}min (10:15 UTC)`)
  setTimeout(runSettlement, ms)
})()
