// GET /api/stripe/claim-product?session_id=cs_…
// Verifies the Stripe Checkout Session is paid, then returns an HTML
// page with the download link for the purchased product.
//
// IDEMPOTENT — buyer can refresh / revisit the URL freely. We do not
// invalidate the session ID after first use; Gumroad-style "shown
// once" was confusing buyers and producing support tickets. The session
// ID is itself secret enough (cryptographic random) that bookmarking
// it is acceptable risk for a $29-$49 digital product.

import { stripeGet } from './_stripe.js'
import { corsHeaders } from '../_orbital.js'
import { getProduct } from './_products.js'

const escapeHTML = (s) => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() })
  if (request.method !== 'GET')     return new Response('GET only', { status: 405 })

  const url = new URL(request.url)
  const sid = url.searchParams.get('session_id')
  if (!sid) return errorPage('No session_id provided. If you just purchased, check your email for the receipt — the link is also there.')

  let session
  try {
    session = await stripeGet(env, `/checkout/sessions/${encodeURIComponent(sid)}`)
  } catch (e) {
    return errorPage(`Could not verify your purchase: ${e.message}. Email lucas.kempe@icloud.com if this persists.`)
  }

  if (session.payment_status !== 'paid') {
    return errorPage(`Payment status is "${session.payment_status}" — not yet paid. If you completed checkout, wait 30s and refresh.`)
  }

  const slug = session.metadata?.slug
  const product = getProduct(slug)
  if (!product) return errorPage(`Unknown product slug: ${slug}. Email lucas.kempe@icloud.com.`)

  return successPage(product, session)
}

function successPage(product, session) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="theme-color" content="#0a0d14">
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<meta name="robots" content="noindex, nofollow">
<title>Download — ${escapeHTML(product.name)}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/style.css">
<style>
  .claim-wrap { max-width: 640px; margin: 0 auto; padding: 96px 24px; }
  .claim-card {
    background: var(--bg-card); border: 1px solid rgba(167,139,250,0.4);
    border-radius: 14px; padding: 36px 32px;
    box-shadow: 0 0 40px rgba(167,139,250,0.15);
  }
  .claim-card h1 { font-size: 28px; margin: 0 0 12px; letter-spacing: -0.02em; }
  .claim-card .lead { color: var(--text-muted); margin: 0 0 28px; }
  .download-btn {
    display: inline-block; padding: 14px 28px;
    background: linear-gradient(180deg, #a78bfa, #8b5cf6);
    color: #0a0d14; font-weight: 700;
    border-radius: 10px; text-decoration: none;
    margin: 8px 0 16px;
    box-shadow: 0 8px 24px rgba(167,139,250,0.3);
  }
  .download-btn:hover { transform: translateY(-1px); text-decoration: none; }
  .download-meta { font-family: var(--font-mono); font-size: 12px; color: var(--text-faint); }
  .receipt-note {
    margin-top: 24px; padding: 16px; border: 1px dashed var(--border);
    border-radius: 8px; font-size: 13px; color: var(--text-muted);
  }
  .session-id {
    font-family: var(--font-mono); font-size: 11px; word-break: break-all;
    color: var(--text-faint); margin-top: 12px;
  }
</style>
</head>
<body>
<nav class="nav" aria-label="Primary">
  <a href="/" class="brand">◎ Meridian</a>
</nav>
<main class="claim-wrap">
  <div class="claim-card">
    <div style="font-size: 14px; color: var(--accent-2); font-family: var(--font-mono); letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 8px;">✓ Payment confirmed</div>
    <h1>${escapeHTML(product.name)}</h1>
    <p class="lead">${escapeHTML(product.description)}</p>

    <a href="${escapeHTML(product.download_url)}" class="download-btn" download="${escapeHTML(product.filename)}">
      Download ZIP →
    </a>

    <div class="download-meta">
      File: <code>${escapeHTML(product.filename)}</code>
    </div>

    <div class="receipt-note">
      <strong>Bookmark this page.</strong> You can re-visit this URL anytime
      to re-download. The download link itself is also in your Stripe
      receipt email (sent to ${escapeHTML(session.customer_details?.email || 'your email')}).
      <br><br>
      Lost the link? Email <a href="mailto:lucas.kempe@icloud.com">lucas.kempe@icloud.com</a> with your Stripe receipt.
    </div>

    <div class="session-id">
      session: ${escapeHTML(session.id)}
    </div>
  </div>
</main>
</body>
</html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' }})
}

function errorPage(msg) {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Download — Error</title>
<link rel="stylesheet" href="/style.css"></head><body>
<main style="max-width: 640px; margin: 0 auto; padding: 96px 24px;">
  <h1>Hmm.</h1>
  <p style="color: var(--text-muted);">${escapeHTML(msg)}</p>
  <p><a href="/">← back to ask-meridian.uk</a></p>
</main></body></html>`
  return new Response(html, { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' }})
}
