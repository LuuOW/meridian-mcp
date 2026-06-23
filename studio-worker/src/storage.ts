// KV-backed storage primitives for studio-worker.
//
// Key layout:
//   passkey:{user_id}:{credential_id}      → CredentialRecord (JSON)
//   passkey-list:{user_id}                 → comma-separated credential_ids
//   reg-link:{token}                       → RegLinkRecord  (single-use, 1h)
//   webauthn-challenge:{purpose}:{key}     → string (60s TTL)
//   session:{sid}                          → SessionRecord  (24h)
//   job:{jid}                              → JobRecord     (7d)
//
// The finance-tool fields from finance-mcp/src/storage.ts are deliberately
// dropped — this worker only does auth + blog orchestration, never touches
// Binance or any finance tool. The WebAuthn primitives are reused unchanged.

export interface Env {
  STUDIO_KV: KVNamespace
  RP_NAME: string
  RP_ID: string
  ORIGIN: string
  ADMIN_SECRET: string
  USER_ID: string

  // GitHub App (preferred) OR a single PAT (fallback). The studio never logs
  // either; PAT is fine for a single-tenant install. Switch to a GitHub App
  // installation token when the studio goes multi-tenant.
  GITHUB_TOKEN: string
  GITHUB_REPO?: string  // default "LuuOW/meridian-mcp"

  // Where the page is deployed. Defaults to ask-meridian.uk.
  PUBLIC_ORIGIN?: string
}

export interface CredentialRecord {
  credentialID: string          // base64url
  publicKey: string             // base64url
  counter: number
  transports?: string[]
  createdAt: number
}

export interface RegLinkRecord {
  user_id: string
  expires_at: number
  used: boolean
  created_at: number
}

export interface SessionRecord {
  user_id: string
  issued_at: number
  expires_at: number
  // user agent fingerprint, optional — protects against token theft across devices
  ua?: string
}

// One row per blog creation job. The whole state machine lives in `stage`.
// Persisting to KV with 7-day expiry keeps the audit trail even after
// the job completes.
export type JobStage =
  | "queued"
  | "fetching"        // pulling arxiv metadata
  | "drafting"        // composing body
  | "banner"          // composing banner svg
  | "committing"      // git add + git commit locally
  | "pushing"         // git push origin main (or branch)
  | "deploying"       // waiting for github actions pages deploy
  | "live"            // 200 OK from ask-meridian.uk
  | "failed"

export interface JobRecord {
  id: string
  user_id: string
  arxiv_url: string
  arxiv_id: string                // 2606.xxxxx
  abs_url: string                 // canonical https://arxiv.org/abs/<id>
  slug: string | null             // decided at drafting stage
  title: string | null
  abstract: string | null
  stage: JobStage
  stage_history: { stage: JobStage; at: number; note?: string }[]
  live_url: string | null
  error: string | null
  banner_commit?: string          // commit sha for the SVG push
  page_commit?: string            // commit sha for the page push
  index_commit?: string | null    // commit sha for the index card push
  created_at: number
  updated_at: number
}

const TTL_REG_LINK = 60 * 60               // 1h to use the link
const TTL_CHALLENGE = 60                   // 60s WebAuthn challenge
const TTL_SESSION   = 24 * 60 * 60         // 24h session
const TTL_JOB       = 7  * 24 * 60 * 60    // 7d job audit

// ─── Passkeys ───────────────────────────────────────────────────────
export async function savePasskey(
  env: Env,
  userId: string,
  cred: CredentialRecord,
): Promise<void> {
  const key = `passkey:${userId}:${cred.credentialID}`
  await env.STUDIO_KV.put(key, JSON.stringify(cred))
  const list = (await env.STUDIO_KV.get(`passkey-list:${userId}`)) ?? ""
  const ids = new Set(list.split(",").filter(Boolean))
  ids.add(cred.credentialID)
  await env.STUDIO_KV.put(`passkey-list:${userId}`, [...ids].join(","))
}

export async function getPasskey(
  env: Env,
  userId: string,
  credentialId: string,
): Promise<CredentialRecord | null> {
  const raw = await env.STUDIO_KV.get(`passkey:${userId}:${credentialId}`)
  return raw ? (JSON.parse(raw) as CredentialRecord) : null
}

export async function listPasskeys(
  env: Env,
  userId: string,
): Promise<CredentialRecord[]> {
  const list = (await env.STUDIO_KV.get(`passkey-list:${userId}`)) ?? ""
  const ids = list.split(",").filter(Boolean)
  const records = await Promise.all(ids.map((id) => getPasskey(env, userId, id)))
  return records.filter((r): r is CredentialRecord => r !== null)
}

export async function updatePasskeyCounter(
  env: Env,
  userId: string,
  credentialId: string,
  newCounter: number,
): Promise<void> {
  const cred = await getPasskey(env, userId, credentialId)
  if (!cred) return
  cred.counter = newCounter
  await env.STUDIO_KV.put(`passkey:${userId}:${credentialId}`, JSON.stringify(cred))
}

// ─── Registration links (one-time) ──────────────────────────────────
export async function createRegLink(env: Env, userId: string): Promise<string> {
  const token = randomToken(32)
  const record: RegLinkRecord = {
    user_id: userId,
    expires_at: Date.now() + TTL_REG_LINK * 1000,
    used: false,
    created_at: Date.now(),
  }
  await env.STUDIO_KV.put(`reg-link:${token}`, JSON.stringify(record), {
    expirationTtl: TTL_REG_LINK,
  })
  return token
}

export async function getRegLink(env: Env, token: string): Promise<RegLinkRecord | null> {
  const raw = await env.STUDIO_KV.get(`reg-link:${token}`)
  return raw ? (JSON.parse(raw) as RegLinkRecord) : null
}

export async function consumeRegLink(env: Env, token: string): Promise<void> {
  await env.STUDIO_KV.delete(`reg-link:${token}`)
}

// ─── WebAuthn challenges ────────────────────────────────────────────
export async function saveChallenge(
  env: Env,
  purpose: "register" | "auth",
  key: string,
  challenge: string,
): Promise<void> {
  await env.STUDIO_KV.put(`webauthn-challenge:${purpose}:${key}`, challenge, {
    expirationTtl: TTL_CHALLENGE,
  })
}

export async function consumeChallenge(
  env: Env,
  purpose: "register" | "auth",
  key: string,
): Promise<string | null> {
  const challenge = await env.STUDIO_KV.get(`webauthn-challenge:${purpose}:${key}`)
  if (challenge) await env.STUDIO_KV.delete(`webauthn-challenge:${purpose}:${key}`)
  return challenge
}

// ─── Sessions ──────────────────────────────────────────────────────
// Cookie sid is 32 random bytes; record in KV with TTL.
export async function createSession(env: Env, userId: string, ua?: string): Promise<string> {
  const sid = randomToken(32)
  const record: SessionRecord = {
    user_id: userId,
    issued_at: Date.now(),
    expires_at: Date.now() + TTL_SESSION * 1000,
    ua,
  }
  await env.STUDIO_KV.put(`session:${sid}`, JSON.stringify(record), {
    expirationTtl: TTL_SESSION,
  })
  return sid
}

export async function getSession(env: Env, sid: string): Promise<SessionRecord | null> {
  const raw = await env.STUDIO_KV.get(`session:${sid}`)
  if (!raw) return null
  const rec = JSON.parse(raw) as SessionRecord
  if (rec.expires_at < Date.now()) return null
  return rec
}

export async function destroySession(env: Env, sid: string): Promise<void> {
  await env.STUDIO_KV.delete(`session:${sid}`)
}

// ─── Blog creation jobs ────────────────────────────────────────────
export async function createJob(
  env: Env,
  userId: string,
  arxivUrl: string,
  arxivId: string,
  absUrl: string,
): Promise<JobRecord> {
  const id = randomToken(16)
  const now = Date.now()
  const rec: JobRecord = {
    id,
    user_id: userId,
    arxiv_url: arxivUrl,
    arxiv_id: arxivId,
    abs_url: absUrl,
    slug: null,
    title: null,
    abstract: null,
    stage: "queued",
    stage_history: [{ stage: "queued", at: now }],
    live_url: null,
    error: null,
    created_at: now,
    updated_at: now,
  }
  await env.STUDIO_KV.put(`job:${id}`, JSON.stringify(rec), {
    expirationTtl: TTL_JOB,
  })
  return rec
}

export async function getJob(env: Env, id: string): Promise<JobRecord | null> {
  const raw = await env.STUDIO_KV.get(`job:${id}`)
  if (!raw) return null
  return JSON.parse(raw) as JobRecord
}

export async function listJobs(env: Env, userId: string, limit = 25): Promise<JobRecord[]> {
  const list = await env.STUDIO_KV.list<{ name: string }>({ prefix: "job:" })
  const jobs: JobRecord[] = []
  for (const k of list.keys) {
    const raw = await env.STUDIO_KV.get(k.name)
    if (!raw) continue
    const rec = JSON.parse(raw) as JobRecord
    if (rec.user_id === userId) jobs.push(rec)
  }
  jobs.sort((a, b) => b.created_at - a.created_at)
  return jobs.slice(0, limit)
}

export async function updateJob(env: Env, id: string, patch: Partial<JobRecord>): Promise<JobRecord | null> {
  const rec = await getJob(env, id)
  if (!rec) return null
  const now = Date.now()
  const next: JobRecord = {
    ...rec,
    ...patch,
    updated_at: now,
    stage_history: patch.stage && patch.stage !== rec.stage
      ? [...rec.stage_history, { stage: patch.stage, at: now, note: patch.error ?? undefined }]
      : rec.stage_history,
  }
  await env.STUDIO_KV.put(`job:${id}`, JSON.stringify(next), {
    expirationTtl: TTL_JOB,
  })
  return next
}

// ─── helpers ────────────────────────────────────────────────────────
export function randomToken(byteLen: number): string {
  const buf = new Uint8Array(byteLen)
  crypto.getRandomValues(buf)
  return base64urlEncode(buf)
}

export function base64urlEncode(buf: Uint8Array): string {
  let s = ""
  for (const b of buf) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function base64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4))
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// Cookie helpers — keep session id in an HttpOnly + Secure + SameSite=Strict
// cookie. Path-scoped to /studio so it doesn't leak to /.
export const STUDIO_COOKIE = "studio_sid"

export function sessionCookie(sid: string, maxAgeSec = TTL_SESSION): string {
  return `${STUDIO_COOKIE}=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/studio; Max-Age=${maxAgeSec}`
}

export function clearSessionCookie(): string {
  return `${STUDIO_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/studio; Max-Age=0`
}

export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf("=")
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    if (k === STUDIO_COOKIE) return part.slice(eq + 1).trim()
  }
  return null
}
