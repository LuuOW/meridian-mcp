// ask-meridian.uk fulfillment worker.
//
// Responsibilities:
//   POST /stripe/webhook   — verify Stripe signature, ack 200
//   GET  /stripe/claim     — exchange ?session_id= for the buyer's download
//
// Secrets (wrangler secret put):
//   STRIPE_SECRET_KEY      — sk_live_...
//   STRIPE_WEBHOOK_SECRET  — whsec_...

const PRODUCT_DOWNLOADS = {
  // Build Your Own MCP — $29 PDF + repo
  prod_US8keFnXtyUSK2: {
    file: "zDpgeFgXnp5p2N_1JsOFniG7e5MB3VvD.zip",
    title: "Build Your Own MCP Server",
  },
  // MCP Server Pack — $49 10 servers
  prod_US8k9Lg9szSn9D: {
    file: "gadVns9GJ-qIEahkIJQGkcqxwbXGnH-L.zip",
    title: "MCP Server Pack — 10 servers",
  },
};

// Subscription products: no download, manual fulfillment flow.
const SUBSCRIPTION_PRODUCTS = new Set([
  "prod_ULDFL4ixxhmiPK", // Meridian Pro
  "prod_ULDFUu19Uokdh7", // Meridian Team
]);

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/stripe/webhook" && req.method === "POST") {
        return await handleWebhook(req, env);
      }
      if (path === "/stripe/claim" && req.method === "GET") {
        return await handleClaim(req, env, url);
      }
      if (path === "/healthz") {
        return new Response("ok", { headers: { "content-type": "text/plain" } });
      }
      if (path === "/") {
        return new Response("ask-meridian.uk api", {
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      console.error("worker error", e?.stack || e);
      return new Response("internal error", { status: 500 });
    }
  },
};

async function handleWebhook(req, env) {
  const sig = req.headers.get("stripe-signature");
  const body = await req.text();

  if (!sig || !env.STRIPE_WEBHOOK_SECRET) {
    return new Response("missing signature or secret", { status: 400 });
  }

  const verified = await verifyStripeSignature(body, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!verified) {
    return new Response("invalid signature", { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(body);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // Idempotent: just log + ack. Downloads are pulled on-demand at /stripe/claim,
  // so we don't need to mutate state here.
  console.log("stripe event", event.type, event.id);

  if (
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded"
  ) {
    const session = event.data?.object;
    console.log("checkout completed", {
      session_id: session?.id,
      customer_email: session?.customer_details?.email,
      amount_total: session?.amount_total,
      mode: session?.mode,
    });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "content-type": "application/json" },
  });
}

async function handleClaim(req, env, url) {
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId || !/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
    return htmlPage("Invalid session", "That link looks malformed. Forward your Stripe receipt to " + env.SUPPORT_EMAIL + " and I'll send the file.");
  }

  // Fetch the session + line items to identify the product.
  const resp = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${sessionId}?expand[]=line_items`,
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
  );
  if (!resp.ok) {
    console.error("stripe session fetch failed", resp.status, await resp.text());
    return htmlPage("Couldn't verify your purchase", "Forward your Stripe receipt to " + env.SUPPORT_EMAIL + " and I'll send the file.");
  }
  const session = await resp.json();

  if (session.payment_status !== "paid" && session.status !== "complete") {
    return htmlPage("Payment pending", "Stripe still shows this checkout as pending. Refresh in a minute or email " + env.SUPPORT_EMAIL + " if it stays stuck.");
  }

  // For subscriptions, no download — point them at the manual-fulfillment page.
  if (session.mode === "subscription") {
    return Response.redirect("https://ask-meridian.uk/success.html", 302);
  }

  // Find the first known product in the line items.
  const items = session.line_items?.data || [];
  let product = null;
  for (const li of items) {
    const pid = li.price?.product;
    if (typeof pid === "string" && PRODUCT_DOWNLOADS[pid]) {
      product = { id: pid, ...PRODUCT_DOWNLOADS[pid] };
      break;
    }
    if (typeof pid === "string" && SUBSCRIPTION_PRODUCTS.has(pid)) {
      return Response.redirect("https://ask-meridian.uk/success.html", 302);
    }
  }

  if (!product) {
    return htmlPage(
      "Purchase confirmed",
      "Your payment went through, but I couldn't auto-match the product. Email " + env.SUPPORT_EMAIL + " with your session id (" + sessionId + ") and I'll send the file."
    );
  }

  const downloadUrl = `${env.DOWNLOADS_BASE}/${product.file}`;
  return htmlPage(
    "Thanks — here's your download",
    `<p style="margin:18px 0;font-size:16px;">${escapeHtml(product.title)}</p>
     <p><a class="dl" href="${escapeAttr(downloadUrl)}" download>↓ Download (.zip)</a></p>
     <p class="hint">Bookmark this page — you can reopen this URL anytime to re-download. Receipt was emailed by Stripe.</p>
     <p class="hint">Trouble? Reply to your Stripe receipt or email <a href="mailto:${escapeAttr(env.SUPPORT_EMAIL)}">${escapeHtml(env.SUPPORT_EMAIL)}</a>.</p>`
  );
}

// ---------- Stripe signature verification (Web Crypto, no SDK) ----------

async function verifyStripeSignature(payload, header, secret) {
  // Header format: "t=TIMESTAMP,v1=SIG[,v1=SIG2...]"
  const parts = Object.create(null);
  for (const p of header.split(",")) {
    const i = p.indexOf("=");
    if (i < 0) continue;
    const k = p.slice(0, i).trim();
    const v = p.slice(i + 1).trim();
    if (k === "t") parts.t = v;
    if (k === "v1") (parts.v1 ||= []).push(v);
  }
  if (!parts.t || !parts.v1?.length) return false;

  // 5-minute tolerance.
  const ts = Number(parts.t);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const signed = `${parts.t}.${payload}`;
  const expected = await hmacHex(secret, signed);
  for (const v of parts.v1) {
    if (timingSafeEqualHex(v, expected)) return true;
  }
  return false;
}

async function hmacHex(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- HTML helpers ----------

function htmlPage(title, bodyHtml) {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${escapeHtml(title)} — Meridian</title>
<meta name="robots" content="noindex,nofollow">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         background:#0a0d14; color:#e5e7eb; margin:0; padding:48px 20px; }
  .card { max-width:560px; margin:0 auto; background:#10131c; border:1px solid #1f2937;
          border-radius:14px; padding:28px; }
  h1 { margin:0 0 10px; font-size:24px; letter-spacing:-0.02em; }
  a { color:#7dd3fc; text-decoration:none; }
  a:hover { text-decoration:underline; }
  a.dl { display:inline-block; margin-top:10px; padding:12px 18px;
         background:#22d3ee; color:#062028; border-radius:8px; font-weight:600; }
  .hint { color:#94a3b8; font-size:13.5px; margin-top:14px; }
</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1>${bodyHtml}</div></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function escapeAttr(s) { return escapeHtml(s); }
