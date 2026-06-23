#!/usr/bin/env node
// Mint a one-time registration link for the studio.
// Usage:
//   ORIGIN=https://studio.ask-meridian.uk \
//   ADMIN_SECRET=... \
//   node scripts/create-link.mjs

const ORIGIN = process.env.ORIGIN || "http://127.0.0.1:8787"
const ADMIN_SECRET = process.env.ADMIN_SECRET
if (!ADMIN_SECRET) {
  console.error("ADMIN_SECRET env var is required")
  process.exit(2)
}
const res = await fetch(`${ORIGIN}/admin/create-registration-link`, {
  method: "POST",
  headers: { "x-admin-secret": ADMIN_SECRET },
})
if (!res.ok) {
  console.error(`failed: ${res.status}`)
  console.error(await res.text())
  process.exit(1)
}
const out = await res.json()
console.log(out.url)
console.log(`expires in ${out.expires_in}s — open in a browser with the passkey device`)
