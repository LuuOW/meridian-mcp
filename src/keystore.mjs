// keystore.mjs — API key lifecycle: create, validate, rate-limit, revoke.
// Persisted to data/keys.json (atomic writes). Provisioned by Stripe webhook.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KEYS_FILE = join(__dirname, '..', 'data', 'keys.json')

function load() {
  if (!existsSync(KEYS_FILE)) return { keys: {} }
  try { return JSON.parse(readFileSync(KEYS_FILE, 'utf8')) }
  catch { return { keys: {} } }
}
function save(data) {
  const tmp = KEYS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, KEYS_FILE)
}

// API keys are generated with a recognizable prefix so they're grep-able in logs.
// We store a SHA-256 hash in the file, not the raw key.
export function generateKey() {
  const random = randomBytes(24).toString('base64url')  // 32 chars base64url
  const key    = `mrd_live_${random}`
  return key
}

function hash(key) {
  return createHash('sha256').update(key).digest('hex')
}

/**
 * Create a new API key. Returns { key, hash } — caller must persist the hash
 * and return `key` to the user exactly once.
 */
export function createKey({ stripe_customer_id, plan = 'pro', monthly_limit = 10000 }) {
  const key = generateKey()
  const h   = hash(key)
  const data = load()
  data.keys[h] = {
    stripe_customer_id,
    plan,
    monthly_limit,
    calls_this_month:       0,
    month_start:            new Date().toISOString().slice(0, 7),  // YYYY-MM
    created_at:             new Date().toISOString(),
    last_used_at:           null,
    active:                 true,
  }
  save(data)
  return { key, hash: h }
}

/**
 * Validate a raw API key. Returns the key record if valid + active + under
 * monthly quota. Side effect: increments calls_this_month on success.
 */
export function validateAndTouch(rawKey) {
  if (!rawKey || !rawKey.startsWith('mrd_live_')) return null
  const h = hash(rawKey)
  const data = load()
  const record = data.keys[h]
  if (!record || !record.active) return null

  // Monthly rollover
  const currentMonth = new Date().toISOString().slice(0, 7)
  if (record.month_start !== currentMonth) {
    record.month_start = currentMonth
    record.calls_this_month = 0
  }

  // Quota check
  if (record.calls_this_month >= record.monthly_limit) {
    record.quota_exceeded = true
    save(data)
    return null
  }

  record.calls_this_month += 1
  record.last_used_at = new Date().toISOString()
  save(data)
  return { hash: h, ...record }
}

export function revokeKey(hash) {
  const data = load()
  if (data.keys[hash]) {
    data.keys[hash].active = false
    save(data)
    return true
  }
  return false
}

export function findByCustomer(customerId) {
  const data = load()
  return Object.entries(data.keys)
    .filter(([_, r]) => r.stripe_customer_id === customerId)
    .map(([h, r]) => ({ hash: h, ...r }))
}

export function listKeys() {
  const data = load()
  return Object.entries(data.keys).map(([h, r]) => ({
    hash_prefix: h.slice(0, 10),
    plan: r.plan,
    calls_this_month: r.calls_this_month,
    monthly_limit: r.monthly_limit,
    active: r.active,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
  }))
}

// ── Pending keys (session_id → raw_key, shown once on checkout success) ─────
import { readFileSync as _rf, writeFileSync as _wf, existsSync as _ex, renameSync as _rn } from 'node:fs'
const PENDING_FILE = join(__dirname, '..', 'data', 'pending.json')
const PENDING_TTL_MS = 15 * 60 * 1000  // 15 minutes

function loadPending() {
  if (!_ex(PENDING_FILE)) return {}
  try { return JSON.parse(_rf(PENDING_FILE, 'utf8')) }
  catch { return {} }
}
function savePending(data) {
  const tmp = PENDING_FILE + '.tmp'
  _wf(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  _rn(tmp, PENDING_FILE)
}

export function pendingStore(sessionId, rawKey) {
  const data = loadPending()
  // purge expired first
  const now = Date.now()
  for (const [sid, v] of Object.entries(data)) {
    if (now - v.created_at > PENDING_TTL_MS) delete data[sid]
  }
  data[sessionId] = { raw_key: rawKey, created_at: now }
  savePending(data)
}

export function pendingClaim(sessionId) {
  const data = loadPending()
  const entry = data[sessionId]
  if (!entry) return null
  if (Date.now() - entry.created_at > PENDING_TTL_MS) {
    delete data[sessionId]
    savePending(data)
    return null
  }
  delete data[sessionId]
  savePending(data)
  return entry.raw_key
}
