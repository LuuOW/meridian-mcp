// HTML pages for studio.worker. Vanilla — no build step. Loads
// @simplewebauthn/browser from CDN.

const SWA_CDN = "https://cdn.jsdelivr.net/npm/@simplewebauthn/browser@11.0.0/dist/bundle/index.js"

const SHELL = (title: string, body: string, scripts = "") => `<!doctype html>
<html lang="en"><meta charset="utf-8">
<title>${title} · Meridian Studio</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --bg: #0a0d14;
    --bg-card: rgba(18, 23, 36, 0.7);
    --bg-deep: #06080f;
    --border: rgba(148, 163, 184, 0.14);
    --border-2: rgba(148, 163, 184, 0.22);
    --text: #e6ecf5;
    --text-muted: #8a94a6;
    --text-faint: #5d6778;
    --accent: #a78bfa;
    --accent-d: #8b5cf6;
    --astro: #38bdf8;
    --ok: #10b981;
    --warn: #fbbf24;
    --err: #f87171;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
    min-height: 100vh;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code, pre { font-family: "JetBrains Mono", ui-monospace, monospace; }
  pre { background: #0f1220; padding: 12px 14px; border-radius: 8px; overflow-x: auto; font-size: 12.5px; }
  button, .btn {
    font: inherit;
    padding: 10px 16px;
    border: 1px solid var(--border-2);
    background: rgba(167, 139, 250, 0.10);
    color: var(--text);
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  button:hover, .btn:hover { background: rgba(167, 139, 250, 0.18); border-color: var(--accent); }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button.primary, .btn.primary {
    background: var(--accent-d);
    border-color: var(--accent-d);
    color: #0a0d14;
    font-weight: 600;
  }
  button.primary:hover, .btn.primary:hover {
    background: var(--accent);
    border-color: var(--accent);
  }
  button.danger, .btn.danger {
    background: rgba(248, 113, 113, 0.10);
    border-color: rgba(248, 113, 113, 0.30);
    color: var(--err);
  }
  button.danger:hover, .btn.danger:hover {
    background: rgba(248, 113, 113, 0.20);
    border-color: var(--err);
  }
  input[type=text], input[type=url], textarea {
    font: inherit;
    background: var(--bg-deep);
    border: 1px solid var(--border-2);
    color: var(--text);
    padding: 9px 12px;
    border-radius: 8px;
    width: 100%;
  }
  input[type=text]:focus, input[type=url]:focus, textarea:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(167, 139, 250, 0.15);
  }
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 16px;
  }
  .muted { color: var(--text-muted); }
  .faint { color: var(--text-faint); font-size: 12.5px; }
  .ok    { color: var(--ok); font-weight: 600; }
  .err   { color: var(--err); font-weight: 600; }
  .warn  { color: var(--warn); }
  .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .row > * { flex: 0 0 auto; }
  .grow { flex: 1 1 auto; }
  .stack > * + * { margin-top: 12px; }
  .pill {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 999px;
    font-family: "JetBrains Mono", monospace;
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .pill.queued     { background: rgba(148,163,184,0.10); color: var(--text-muted); }
  .pill.fetching   { background: rgba(56,189,248,0.10); color: var(--astro); }
  .pill.drafting   { background: rgba(167,139,250,0.10); color: var(--accent); }
  .pill.banner     { background: rgba(167,139,250,0.10); color: var(--accent); }
  .pill.committing { background: rgba(251,191,36,0.10); color: var(--warn); }
  .pill.pushing    { background: rgba(251,191,36,0.10); color: var(--warn); }
  .pill.deploying  { background: rgba(16,185,129,0.10); color: var(--ok); }
  .pill.live       { background: rgba(16,185,129,0.18); color: var(--ok); }
  .pill.failed     { background: rgba(248,113,113,0.18); color: var(--err); }
</style>
${body}
${scripts}
</html>`

export function registrationPage(token: string): string {
  return SHELL(
    "Register passkey",
    `
    <div style="max-width: 480px; margin: 80px auto; padding: 0 24px;">
      <h1 style="font-size: 1.5rem; margin: 0 0 12px;">Register passkey</h1>
      <p class="muted">This is a one-time link to bind your passkey (Face ID / Touch ID / fingerprint / hardware key) to Meridian Studio. After registration this URL is destroyed.</p>
      <p class="faint">If you didn't create this link, ignore and close this tab.</p>
      <button id="go" class="primary">Register passkey</button>
      <p id="status" class="muted" style="margin-top: 16px;"></p>
    </div>
    `,
    `<script type="module">
      import { startRegistration } from "${SWA_CDN}"
      const status = document.getElementById("status")
      const btn = document.getElementById("go")
      btn.addEventListener("click", async () => {
        btn.disabled = true
        status.textContent = "Requesting options…"
        status.className = "muted"
        try {
          const r = await fetch("/register/${token}/options", { method: "POST" })
          if (!r.ok) throw new Error("options: " + r.status)
          const opts = await r.json()
          status.textContent = "Awaiting passkey…"
          const cred = await startRegistration({ optionsJSON: opts })
          status.textContent = "Verifying…"
          const v = await fetch("/register/${token}/verify", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(cred),
          })
          const out = await v.json()
          if (v.ok && out.ok) {
            status.textContent = "✓ Passkey registered. Close this tab; the studio is now unlocked for you."
            status.className = "ok"
            btn.style.display = "none"
          } else {
            status.textContent = "✗ " + (out.reason || "registration failed")
            status.className = "err"
            btn.disabled = false
          }
        } catch (e) {
          status.textContent = "✗ " + e.message
          status.className = "err"
          btn.disabled = false
        }
      })
    </script>`,
  )
}

export function loginPage(challengeKey: string): string {
  return SHELL(
    "Sign in",
    `
    <div style="max-width: 480px; margin: 80px auto; padding: 0 24px;">
      <h1 style="font-size: 1.5rem; margin: 0 0 12px;">Meridian Studio</h1>
      <p class="muted">Sign in with your passkey to draft and publish arXiv briefings.</p>
      <button id="go" class="primary">Sign in with passkey</button>
      <p id="status" class="muted" style="margin-top: 16px;"></p>
    </div>
    `,
    `<script type="module">
      import { startAuthentication } from "${SWA_CDN}"
      const status = document.getElementById("status")
      const btn = document.getElementById("go")
      btn.addEventListener("click", async () => {
        btn.disabled = true
        status.textContent = "Requesting challenge…"
        status.className = "muted"
        try {
          const r = await fetch("/login/options?key=${challengeKey}", { method: "POST" })
          if (!r.ok) throw new Error("options: " + r.status)
          const opts = await r.json()
          status.textContent = "Awaiting passkey…"
          const cred = await startAuthentication({ optionsJSON: opts })
          status.textContent = "Verifying…"
          const v = await fetch("/login/verify?key=${challengeKey}", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(cred),
          })
          const out = await v.json()
          if (v.ok && out.ok) {
            status.textContent = "✓ Authorized. Redirecting…"
            status.className = "ok"
            location.href = "/studio"
          } else {
            status.textContent = "✗ " + (out.reason || "auth failed")
            status.className = "err"
            btn.disabled = false
          }
        } catch (e) {
          status.textContent = "✗ " + e.message
          status.className = "err"
          btn.disabled = false
        }
      })
    </script>`,
  )
}

export function statusPage(opts: { passkeysRegistered: number; origin: string }): string {
  return SHELL(
    "Status",
    `
    <div style="max-width: 560px; margin: 80px auto; padding: 0 24px;">
      <h1 style="font-size: 1.5rem; margin: 0 0 12px;">Meridian Studio</h1>
      <div class="card stack">
        <div><strong>Origin</strong>: <code>${opts.origin}</code></div>
        <div><strong>Passkeys registered</strong>: ${opts.passkeysRegistered}</div>
        <div class="muted">Bootstrap a passkey once. After that, /studio only requires your biometric.</div>
      </div>
      <p class="faint">To bootstrap the first passkey, the studio admin posts to <code>/admin/create-registration-link</code> with the <code>X-Admin-Secret</code> header. The returned URL is the only path that exposes a registration form.</p>
    </div>
    `,
  )
}
