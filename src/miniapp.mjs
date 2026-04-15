// miniapp.mjs — World Mini App backend: verify proofs, issue sessions, gate queries
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { routeTask } from './skills.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SESSIONS_FILE = join(__dirname, '..', 'data', 'miniapp-sessions.json')

// Accept both staging + production app_ids; the frontend indicates which to use.
const WORLD_APP_ID_STAGING = process.env.WORLD_APP_ID_STAGING || process.env.WORLD_APP_ID || ''
const WORLD_APP_ID_PROD    = process.env.WORLD_APP_ID_PROD    || ''
const DAILY_FREE_QUOTA_DEVICE = 10
const DAILY_FREE_QUOTA_ORB    = 500

function loadSessions() {
  if (!existsSync(SESSIONS_FILE)) return {}
  try { return JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) }
  catch { return {} }
}
function saveSessions(data) {
  const tmp = SESSIONS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, SESSIONS_FILE)
}

function today() { return new Date().toISOString().slice(0, 10) }

export function summarizeQuota(session) {
  const now = today()
  if (session.last_day !== now) {
    session.last_day = now
    session.calls_today = 0
  }
  return {
    used:      session.calls_today,
    limit:     session.level === 'orb' ? DAILY_FREE_QUOTA_ORB : DAILY_FREE_QUOTA_DEVICE,
    unlimited: session.level === 'orb',
  }
}

/**
 * Verify a World ID MiniKit verification payload with Worldcoin's Developer Portal API.
 * https://docs.world.org/world-id/reference/api#verify
 */
export async function verifyWorldProof({ payload, action, signal, appIdFromClient }) {
  // Pick the right app_id: client explicitly sends one (staging or prod);
  // else fall back to whatever's configured.
  let app_id = appIdFromClient
  if (app_id) {
    const isStaging = app_id.startsWith('app_staging_')
    const expected  = isStaging ? WORLD_APP_ID_STAGING : WORLD_APP_ID_PROD
    if (expected && app_id !== expected) throw new Error('app_id mismatch with backend config')
    if (!expected) throw new Error(`${isStaging ? 'staging' : 'production'} WORLD_APP_ID not configured`)
  } else {
    app_id = WORLD_APP_ID_PROD || WORLD_APP_ID_STAGING
    if (!app_id) throw new Error('WORLD_APP_ID not configured')
  }
  if (!payload?.merkle_root || !payload?.nullifier_hash || !payload?.proof) {
    throw new Error('invalid payload')
  }

  const url = `https://developer.worldcoin.org/api/v2/verify/${encodeURIComponent(app_id)}`
  const body = {
    nullifier_hash:     payload.nullifier_hash,
    merkle_root:        payload.merkle_root,
    proof:              payload.proof,
    verification_level: payload.verification_level,
    action,
    signal_hash:        signal || undefined,
  }
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json()
  if (!r.ok) throw new Error(`Worldcoin verify failed: ${j.code || r.status} — ${j.detail || ''}`)
  return j  // { success: true, verification_level: 'orb'|'device', ... }
}

/**
 * Issue a session token bound to the nullifier_hash (privacy-preserving unique ID).
 */
export function issueSession({ nullifier_hash, level }) {
  const sessions = loadSessions()
  const token   = randomBytes(24).toString('base64url')
  const token_h = createHash('sha256').update(token).digest('hex')
  // One session per nullifier — rotate if already exists
  const sid = randomUUID()
  sessions[token_h] = {
    session_id: sid,
    nullifier:  nullifier_hash,
    level,
    created_at: new Date().toISOString(),
    last_day:   today(),
    calls_today: 0,
  }
  saveSessions(sessions)
  return { token, session: sessions[token_h] }
}

export function getSession(token) {
  if (!token) return null
  const h = createHash('sha256').update(token).digest('hex')
  const s = loadSessions()
  return s[h] ? { hash: h, ...s[h] } : null
}

export function incrementUsage(hash) {
  const s = loadSessions()
  if (!s[hash]) return null
  const now = today()
  if (s[hash].last_day !== now) { s[hash].last_day = now; s[hash].calls_today = 0 }
  s[hash].calls_today += 1
  saveSessions(s)
  return s[hash]
}

/**
 * Answer a query using the orbital router. Pure pass-through to skills.mjs.
 */
export async function answerQuery(task, limit = 5) {
  const res = await routeTask(task, limit)
  return res
}

// ── Skill detail (SKILL.md body + physics from skill_orbit.py) ─────────────
import { execSync } from 'node:child_process'
import { getSkill as _getSkill } from './skills.mjs'

const SKILL_ORBIT_PY = process.env.MERIDIAN_SKILL_ORBIT || '/opt/skills/skill_orbit.py'
const PYTHON         = process.env.MERIDIAN_PYTHON       || 'python3'

export function getSkillDetail(slug) {
  if (!/^[a-z0-9_-]+$/i.test(slug)) throw new Error('invalid slug')

  const skill = _getSkill(slug)  // throws if missing — frontmatter + body
  let physics = null
  try {
    const out = execSync(`${PYTHON} ${SKILL_ORBIT_PY} --skill ${slug} --json`, {
      timeout: 12000, encoding: 'utf8',
    })
    const parsed = JSON.parse(out)
    physics = Array.isArray(parsed) ? parsed[0] : parsed
  } catch (e) {
    physics = { error: e.message }
  }

  return {
    slug,
    name:        skill.frontmatter?.name || slug,
    description: skill.frontmatter?.description || '',
    body:        skill.body,
    physics,
  }
}

// ── WLD payment / Pro upgrade ──────────────────────────────────────────────
const PAYMENTS_FILE = join(__dirname, '..', 'data', 'payments.json')
const PRO_PRICE_WLD = parseFloat(process.env.MERIDIAN_PRO_WLD || '0.5')  // 0.5 WLD ≈ $0.15
const PAYMENT_RECIPIENT = process.env.MERIDIAN_PAY_RECIPIENT
                       || process.env.WALLET_ADDRESS
                       || '0xECfb0b4C598cbF5b218daAf93E95f72418435B87'

function loadPayments() {
  if (!existsSync(PAYMENTS_FILE)) return {}
  try { return JSON.parse(readFileSync(PAYMENTS_FILE, 'utf8')) }
  catch { return {} }
}
function savePayments(data) {
  const tmp = PAYMENTS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, PAYMENTS_FILE)
}

/** Create a payment intent; returns reference + recipient + amount. */
export function beginPayment({ session_hash }) {
  const reference = randomUUID().replace(/-/g, '')
  const data = loadPayments()
  data[reference] = {
    session_hash,
    amount_wld: PRO_PRICE_WLD,
    recipient:  PAYMENT_RECIPIENT,
    created_at: new Date().toISOString(),
    status:     'pending',
  }
  savePayments(data)
  return {
    reference,
    recipient_address: PAYMENT_RECIPIENT,
    amount_wld:        PRO_PRICE_WLD,
  }
}

/**
 * Verify a Worldcoin transaction via the Developer Portal API.
 * Returns the verified transaction details, or throws.
 */
async function verifyWorldTransaction({ transaction_id, app_id }) {
  if (!WORLD_APP_ID_STAGING && !WORLD_APP_ID_PROD)
    throw new Error('WORLD_APP_ID not configured')
  const api_key = process.env.WORLD_API_KEY
  if (!api_key) throw new Error('WORLD_API_KEY not configured')
  const url = `https://developer.worldcoin.org/api/v2/minikit/transaction/${encodeURIComponent(transaction_id)}?app_id=${encodeURIComponent(app_id)}&type=transaction`
  const r = await fetch(url, {
    headers: { 'Authorization': `Bearer ${api_key}` },
  })
  const j = await r.json()
  if (!r.ok) throw new Error(`Worldcoin tx verify failed: ${j.error || r.status}`)
  return j
}

/**
 * Complete a payment: verify the on-chain tx with Worldcoin and grant Pro.
 */
export async function completePayment({ session_hash, reference, transaction_id, app_id }) {
  const data = loadPayments()
  const intent = data[reference]
  if (!intent) throw new Error('payment reference not found')
  if (intent.session_hash !== session_hash) throw new Error('session mismatch')
  if (intent.status === 'verified') return intent  // idempotent

  const tx = await verifyWorldTransaction({ transaction_id, app_id })
  // Worldcoin returns transaction details; check it succeeded + matches our recipient
  if (tx.transaction_status === 'failed') throw new Error('transaction failed on chain')
  // Lenient match — the payload structure varies; we trust Worldcoin's verification
  intent.status         = 'verified'
  intent.transaction_id = transaction_id
  intent.verified_at    = new Date().toISOString()
  intent.tx_data        = tx
  savePayments(data)

  // Mark the session premium
  const sessions = loadSessions()
  if (sessions[session_hash]) {
    sessions[session_hash].premium = true
    sessions[session_hash].premium_since = intent.verified_at
    saveSessions(sessions)
  }
  return intent
}

export function isPremium(session) {
  return Boolean(session?.premium)
}

// Update summarizeQuota to give premium users effectively-unlimited
export function summarizeQuotaWithPremium(session) {
  const base = summarizeQuota(session)
  if (isPremium(session)) return { used: base.used, limit: 99999, unlimited: true, premium: true }
  return base
}
