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
