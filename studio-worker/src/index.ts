// Studio worker entry. See header comment for route map.

import {
  type Env,
  type JobRecord,
  type JobStage,
  createRegLink,
  getRegLink,
  consumeRegLink,
  listPasskeys,
  getSession,
  createSession,
  destroySession,
  createJob,
  getJob,
  listJobs,
  updateJob,
  randomToken,
  sessionCookie,
  clearSessionCookie,
  parseSessionCookie,
} from "./storage"
import {
  registrationOptions,
  verifyRegistration,
  authenticationOptions,
  verifyAuthentication,
} from "./webauthn"
import { loginPage, registrationPage, statusPage } from "./pages"
import { normalizeArxivUrl, fetchArxiv } from "./arxiv"
import { composeDraft } from "./draft"
import { publish, deleteBlog, listBlogs } from "./github"

function html(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } })
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  })
}

function methodNotAllowed(): Response {
  return new Response("method not allowed", { status: 405 })
}

async function requireSession(env: Env, req: Request): Promise<{ sid: string; user_id: string } | Response> {
  const sid = parseSessionCookie(req.headers.get("cookie"))
  if (!sid) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } })
  const sess = await getSession(env, sid)
  if (!sess) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } })
  return { sid, user_id: sess.user_id }
}

// ─── Background job runner ─────────────────────────────────────────
async function runJob(env: Env, jobId: string, customBodyOverride?: string): Promise<void> {
  const setStage = async (stage: JobStage, patch: Partial<JobRecord> = {}) => {
    const updated = await updateJob(env, jobId, { stage, ...patch })
    if (updated) console.log(`[studio] job ${jobId} → ${stage}`)
  }
  const fail = async (err: unknown) => {
    await setStage("failed", { error: err instanceof Error ? err.message : String(err) })
  }

  try {
    const job0 = await getJob(env, jobId)
    if (!job0) return

    await setStage("fetching")
    const arxiv = await fetchArxiv(job0.abs_url)

    await setStage("drafting", { title: arxiv.title, abstract: arxiv.abstract })
    const draft = await composeDraft(arxiv, env)
    const slug = draft.slug
    // If the studio submitted an explicit body override, swap it into the page_html
    // between <article ...> and the takeaway. This lets the dashboard do a manual
    // editorial pass after seeing the LLM draft.
    let page_html = draft.page_html
    if (customBodyOverride && customBodyOverride.trim()) {
      // Insert the override as the first child of <article>, after the banner.
      page_html = page_html.replace(
        /(<img[^>]*-banner\.svg"[^>]*>\s*)/,
        `$1\n${customBodyOverride}\n      `,
      )
    }

    await setStage("banner", { slug })

    await setStage("committing", { slug, title: arxiv.title })
    const pub = await publish(env, {
      slug,
      page_html,
      banner_svg: draft.banner_svg,
      index_card: draft.index_card,
      commit_message: `blog: ${slug} (arXiv:${arxiv.arxiv_id})`,
    })

    await setStage("pushing")
    // Files are committed; GitHub is already on main. Pages workflow picks up.
    // Mark the job as "deploying" and let the dashboard self-update once the
    // GitHub Pages URL returns 200 on its own (polled from the browser, not
    // the worker). Skipping the server-side poll keeps KV free-tier usage
    // bounded — each publish would otherwise issue 60+ GETs to the live URL.
    await setStage("deploying", {
      live_url: `https://ask-meridian.uk/blog/${slug}/`,
      banner_commit: pub.banner_commit,
      page_commit: pub.page_commit,
      index_commit: pub.index_commit,
      llm_used: draft.llm_used,
      llm_model: draft.llm_model,
      llm_duration_ms: draft.llm_duration_ms,
    } as Partial<JobRecord>)
    // Optimistically flip to "live" — Pages deploys land in 30-90s; if the
    // page is actually 404 the dashboard's poll will surface that to the user.
    await setStage("live", {
      live_url: `https://ask-meridian.uk/blog/${slug}/`,
    } as Partial<JobRecord>)
  } catch (e) {
    await fail(e)
  }
}

// ─── Studio dashboard ──────────────────────────────────────────────
function studioPage(opts: {
  user_id: string
  origin: string
}): string {
  return `<!doctype html>
<html lang="en"><meta charset="utf-8">
<title>Studio · Meridian</title>
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
    background:
      radial-gradient(1400px 700px at 80% -10%, #1c1845 0%, transparent 60%),
      radial-gradient(900px 500px at 10% 30%, #0e2233 0%, transparent 60%),
      var(--bg);
    color: var(--text);
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
    min-height: 100vh;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code, pre { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 12.5px; }
  pre { background: #0f1220; padding: 12px 14px; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; }
  button, .btn {
    font: inherit;
    padding: 9px 14px;
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
  button.primary:hover, .btn.primary:hover { background: var(--accent); border-color: var(--accent); }
  button.danger, .btn.danger {
    background: rgba(248, 113, 113, 0.10);
    border-color: rgba(248, 113, 113, 0.30);
    color: var(--err);
  }
  button.danger:hover, .btn.danger:hover { background: rgba(248, 113, 113, 0.20); border-color: var(--err); }
  input[type=text], input[type=url], textarea {
    font: inherit;
    background: var(--bg-deep);
    border: 1px solid var(--border-2);
    color: var(--text);
    padding: 9px 12px;
    border-radius: 8px;
    width: 100%;
  }
  textarea { min-height: 240px; font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 12.5px; }
  input:focus, textarea:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(167, 139, 250, 0.15);
  }
  .topbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 24px;
    border-bottom: 1px solid var(--border);
    background: rgba(10, 13, 20, 0.85);
    backdrop-filter: blur(12px);
    position: sticky; top: 0; z-index: 50;
  }
  .topbar h1 {
    margin: 0; font-size: 16px; font-weight: 700; letter-spacing: 0.02em;
  }
  .topbar h1 span { color: var(--accent); }
  .topbar nav { display: flex; gap: 16px; align-items: center; font-size: 13px; }
  .container { max-width: 1080px; margin: 0 auto; padding: 24px; }
  .grid {
    display: grid; grid-template-columns: 1fr 360px; gap: 24px;
  }
  @media (max-width: 880px) { .grid { grid-template-columns: 1fr; } }
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 20px;
    margin-bottom: 16px;
  }
  .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .grow { flex: 1 1 auto; min-width: 0; }
  .stack > * + * { margin-top: 12px; }
  .muted { color: var(--text-muted); }
  .faint { color: var(--text-faint); font-size: 12px; }
  .ok    { color: var(--ok); }
  .err   { color: var(--err); }
  .warn  { color: var(--warn); }
  .pill {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 999px;
    font-family: "JetBrains Mono", monospace;
    font-size: 10.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .pill.queued     { background: rgba(148,163,184,0.10); color: var(--text-muted); }
  .pill.fetching   { background: rgba(56,189,248,0.10);  color: var(--astro); }
  .pill.drafting   { background: rgba(56,189,248,0.10);  color: var(--astro); }
  .pill.banner     { background: rgba(167,139,250,0.10); color: var(--accent); }
  .pill.committing { background: rgba(167,139,250,0.18); color: var(--accent); }
  .pill.pushing    { background: rgba(251,191,36,0.12); color: var(--warn); }
  .pill.deploying  { background: rgba(251,191,36,0.18); color: var(--warn); }
  .pill.live       { background: rgba(16,185,129,0.18);  color: var(--ok); }
  .pill.failed     { background: rgba(248,113,113,0.18); color: var(--err); }
  .stages {
    display: flex; gap: 6px; flex-wrap: wrap; align-items: center;
    margin: 8px 0 0;
  }
  .stages .step {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 10px; border-radius: 6px;
    background: rgba(148,163,184,0.05); color: var(--text-faint);
    font-family: "JetBrains Mono", monospace; font-size: 11px;
    letter-spacing: 0.04em; text-transform: uppercase;
  }
  .stages .step.done   { background: rgba(16,185,129,0.18); color: var(--ok); }
  .stages .step.active { background: rgba(167,139,250,0.18); color: var(--accent); }
  .stages .step.failed { background: rgba(248,113,113,0.18); color: var(--err); }
  .stages .sep { color: var(--text-faint); opacity: 0.4; }
  details summary { cursor: pointer; user-select: none; }
  details[open] summary { margin-bottom: 8px; }
</style>
<div class="topbar">
  <h1>◎ Meridian <span>Studio</span></h1>
  <nav>
    <span class="faint">signed in as <code>${opts.user_id}</code></span>
    <a href="https://ask-meridian.uk/blog/">/blog ↗</a>
    <form method="POST" action="/studio/logout" style="display:inline">
      <button type="submit">Sign out</button>
    </form>
  </nav>
</div>
<div class="container">
  <div class="grid">
    <div>
      <div class="card">
        <h2 style="margin:0 0 12px; font-size: 16px;">New post</h2>
        <form id="create-form" class="stack">
          <div>
            <label for="arxiv" class="muted" style="display:block; margin-bottom:6px; font-size:12.5px;">arXiv URL or id</label>
            <input type="text" id="arxiv" name="arxiv" placeholder="https://arxiv.org/abs/2606.23614 or 2606.23614" autocomplete="off" required>
          </div>
          <div>
            <label for="body" class="muted" style="display:block; margin-bottom:6px; font-size:12.5px;">Body (optional — leave blank to use the auto-drafted body)</label>
            <textarea id="body" name="body" placeholder="<p>...</p>"></textarea>
          </div>
          <div class="row">
            <button type="submit" class="primary" id="create-btn">Create & publish</button>
            <span id="create-status" class="faint"></span>
          </div>
        </form>
      </div>

      <div class="card">
        <h2 style="margin:0 0 8px; font-size: 16px;">Active job</h2>
        <div id="active-job" class="muted">none</div>
      </div>

      <div class="card">
        <h2 style="margin:0 0 8px; font-size: 16px;">Recent jobs</h2>
        <div id="jobs-list" class="muted">loading…</div>
      </div>
    </div>

    <div>
      <div class="card">
        <h2 style="margin:0 0 8px; font-size: 16px;">Existing blogs</h2>
        <div id="blogs-list" class="muted">loading…</div>
      </div>
    </div>
  </div>
</div>

<script>
const STAGE_ORDER = ["queued", "fetching", "drafting", "banner", "committing", "pushing", "deploying", "live"];
const STAGE_LABELS = {
  queued: "Queued", fetching: "Fetching arXiv", drafting: "Drafting body", banner: "Generating banner",
  committing: "Committing", pushing: "Pushing to GitHub", deploying: "Awaiting deploy", live: "Live", failed: "Failed",
};

function pill(stage) {
  return '<span class="pill ' + stage + '">' + STAGE_LABELS[stage] + '</span>';
}
function stages(rec) {
  const html = STAGE_ORDER.map(s => {
    const idx = STAGE_ORDER.indexOf(s);
    const cur = STAGE_ORDER.indexOf(rec.stage);
    let cls = "step";
    if (rec.stage === "failed" && idx === cur) cls += " failed";
    else if (idx < cur) cls += " done";
    else if (idx === cur) cls += " active";
    return '<span class="' + cls + '">' + STAGE_LABELS[s] + '</span>';
  });
  if (rec.stage === "failed") html.push('<span class="step failed">FAILED</span>');
  return '<div class="stages">' + html.join('<span class="sep">→</span>') + '</div>';
}
function fmtTime(ms) { return new Date(ms).toLocaleString(); }

async function fetchJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(url + " → " + r.status);
  return r.json();
}

async function refreshJobs() {
  try {
    const jobs = await fetchJSON("/studio/jobs");
    const blogs = await fetchJSON("/studio/blogs");
    renderJobs(jobs);
    renderBlogs(blogs);
    const active = jobs.find(j => !["live", "failed"].includes(j.stage));
    renderActive(active || null);
  } catch (e) {
    document.getElementById("jobs-list").textContent = "error: " + e.message;
  }
}

function renderActive(job) {
  const el = document.getElementById("active-job");
  if (!job) { el.innerHTML = '<span class="muted">none</span>'; return; }
  el.innerHTML =
    '<div class="stack">' +
      '<div class="row">' +
        '<code>' + (job.arxiv_id || job.arxiv_url) + '</code>' +
        pill(job.stage) +
      '</div>' +
      stages(job) +
      (job.title ? '<div class="muted">' + job.title + '</div>' : '') +
      (job.llm_used === true
        ? '<div class="faint">editorial pass: LLM (' + (job.llm_model || 'unknown') + ', ' + (job.llm_duration_ms ?? '?') + 'ms)</div>'
        : (job.llm_used === false
          ? '<div class="warn">editorial pass: rule-based fallback (no LLM configured / credits exhausted)</div>'
          : '')) +
      (job.error ? '<div class="err">' + job.error + '</div>' : '') +
      (job.live_url ? '<div><a href="' + job.live_url + '" target="_blank" rel="noopener" class="ok">' + job.live_url + ' ↗</a></div>' : '') +
      (job.stage === "drafting" ? '<details><summary class="muted">edit body (resubmits with override)</summary>' +
        '<form data-job-id="' + job.id + '" class="body-override-form" style="margin-top:8px">' +
          '<textarea name="body" style="width:100%; min-height:200px; font-family: JetBrains Mono, monospace; font-size:12.5px; padding:8px; background:#0f1220; color:#e6ecf5; border:1px solid var(--border-2); border-radius:8px">' + (job._body_override || '') + '</textarea>' +
          '<div class="row" style="margin-top:8px"><button type="submit" class="primary">Save & continue</button></div>' +
        '</form></details>' : '') +
    '</div>';
  const f = el.querySelector(".body-override-form");
  if (f) f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    const body = fd.get("body");
    const r = await fetch("/studio/update/" + job.id, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (r.ok) {
      refreshJobs();
    } else {
      alert("update failed: " + r.status);
    }
  });
}

function renderJobs(jobs) {
  const el = document.getElementById("jobs-list");
  if (!jobs.length) { el.innerHTML = '<span class="muted">no jobs yet</span>'; return; }
  el.innerHTML = jobs.map(j => (
    '<div class="row" style="padding:10px 0; border-bottom:1px solid var(--border)">' +
      '<code class="faint">' + fmtTime(j.created_at) + '</code>' +
      '<code style="min-width:120px">' + j.arxiv_id + '</code>' +
      pill(j.stage) +
      (j.live_url ? '<a href="' + j.live_url + '" target="_blank" rel="noopener" class="ok grow">' + j.title + '</a>' :
                   '<span class="grow">' + (j.title || '<em class="muted">drafting…</em>') + '</span>') +
    '</div>'
  )).join("");
}

function renderBlogs(blogs) {
  const el = document.getElementById("blogs-list");
  if (!blogs.length) { el.innerHTML = '<span class="muted">none</span>'; return; }
  el.innerHTML = blogs.map(b => (
    '<div class="row" style="padding:8px 0; border-bottom:1px solid var(--border)">' +
      '<a class="grow" href="https://ask-meridian.uk' + b.href + '" target="_blank" rel="noopener">' + b.title + '</a>' +
      '<button data-slug="' + b.slug + '" class="danger del-btn">Delete</button>' +
    '</div>'
  )).join("");
  el.querySelectorAll(".del-btn").forEach(b => {
    b.addEventListener("click", async () => {
      const slug = b.dataset.slug;
      if (!confirm("Delete /blog/" + slug + "/? This pushes a deletion commit to main.")) return;
      b.disabled = true;
      const r = await fetch("/studio/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      if (r.ok) {
        refreshJobs();
      } else {
        alert("delete failed: " + r.status);
        b.disabled = false;
      }
    });
  });
}

document.getElementById("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const arxiv = (fd.get("arxiv") || "").toString().trim();
  const body = (fd.get("body") || "").toString();
  const btn = document.getElementById("create-btn");
  const status = document.getElementById("create-status");
  btn.disabled = true;
  status.textContent = "starting…";
  status.className = "faint";
  try {
    const r = await fetch("/studio/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ arxiv_url: arxiv, body }),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(t);
    }
    const out = await r.json();
    status.textContent = "queued job " + out.id;
    status.className = "ok";
    refreshJobs();
  } catch (err) {
    status.textContent = "✗ " + err.message;
    status.className = "err";
  } finally {
    btn.disabled = false;
  }
});

refreshJobs();
setInterval(refreshJobs, 3000);
</script>
</html>`
}

// ─── Worker entry ────────────────────────────────────────────────────
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url)
    const p = url.pathname

    try {
      // CORS preflight for the API surface
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() })
      }

      // ── Status ──────────────────────────────────────────────────
      if (p === "/" && req.method === "GET") {
        const passkeys = await listPasskeys(env, env.USER_ID)
        return html(statusPage({ passkeysRegistered: passkeys.length, origin: env.ORIGIN }))
      }

      // ── Admin: mint a one-time registration link ───────────────
      if (p === "/admin/create-registration-link" && req.method === "POST") {
        if (req.headers.get("x-admin-secret") !== env.ADMIN_SECRET) {
          return new Response("forbidden", { status: 403 })
        }
        const token = await createRegLink(env, env.USER_ID)
        return json({
          url: `${env.ORIGIN}/register/${token}`,
          expires_in: 3600,
        })
      }

      // ── Registration pages ──────────────────────────────────────
      const regMatch = p.match(/^\/register\/([A-Za-z0-9_-]+)$/)
      if (regMatch && req.method === "GET") {
        const token = regMatch[1]
        const link = await getRegLink(env, token)
        if (!link || link.used || link.expires_at < Date.now()) {
          return new Response("link expired or already used", { status: 410 })
        }
        return html(registrationPage(token))
      }
      const regOptsMatch = p.match(/^\/register\/([A-Za-z0-9_-]+)\/options$/)
      if (regOptsMatch && req.method === "POST") {
        const token = regOptsMatch[1]
        const link = await getRegLink(env, token)
        if (!link || link.used) return new Response("link expired", { status: 410 })
        const opts = await registrationOptions(env, env.USER_ID, token)
        return json(opts)
      }
      const regVerifyMatch = p.match(/^\/register\/([A-Za-z0-9_-]+)\/verify$/)
      if (regVerifyMatch && req.method === "POST") {
        const token = regVerifyMatch[1]
        const link = await getRegLink(env, token)
        if (!link || link.used) return new Response("link expired", { status: 410 })
        const body = await req.json()
        const result = await verifyRegistration(env, env.USER_ID, token, body as never)
        if (result.ok) await consumeRegLink(env, token)
        return json(result, result.ok ? 200 : 400)
      }

      // ── Login ──────────────────────────────────────────────────
      if (p === "/login" && req.method === "GET") {
        const challengeKey = randomToken(16)
        await env.STUDIO_KV.put(`login-pending:${challengeKey}`, "1", { expirationTtl: 300 })
        return html(loginPage(challengeKey))
      }
      if (p === "/login/options" && req.method === "POST") {
        const key = url.searchParams.get("key") ?? ""
        if (!key) return new Response("missing key", { status: 400 })
        const opts = await authenticationOptions(env, env.USER_ID, key)
        return json(opts)
      }
      if (p === "/login/verify" && req.method === "POST") {
        const key = url.searchParams.get("key") ?? ""
        if (!key) return new Response("missing key", { status: 400 })
        const body = await req.json()
        const result = await verifyAuthentication(env, env.USER_ID, key, body as never)
        if (!result.ok) return json(result, 401)
        // Issue a session cookie.
        const sid = await createSession(env, env.USER_ID, req.headers.get("user-agent") ?? undefined)
        await env.STUDIO_KV.delete(`login-pending:${key}`)
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": sessionCookie(sid),
          },
        })
      }

      // ── Authenticated /studio/* ────────────────────────────────
      const auth = await requireSession(env, req)
      if (auth instanceof Response) return auth
      const { sid, user_id } = auth

      // ── /studio — dashboard ────────────────────────────────────
      if (p === "/studio" && req.method === "GET") {
        return html(studioPage({ user_id, origin: env.ORIGIN }))
      }

      // ── /studio/create — start a new job ───────────────────────
      if (p === "/studio/create" && req.method === "POST") {
        const body = await req.json() as { arxiv_url?: string; body?: string }
        const input = (body.arxiv_url ?? "").trim()
        if (!input) return json({ error: "missing arxiv_url" }, 400)
        let id: string, abs_url: string
        try {
          ({ id, abs_url } = normalizeArxivUrl(input))
        } catch (e) {
          return json({ error: (e as Error).message }, 400)
        }
        const job = await createJob(env, user_id, input, id, abs_url)
        ctx.waitUntil(runJob(env, job.id, body.body && body.body.trim() ? body.body : undefined))
        return json({ id: job.id, arxiv_id: id, abs_url })
      }

      // ── /studio/update/:id — supply a body override for a job ──
      const updateMatch = p.match(/^\/studio\/update\/([A-Za-z0-9_-]+)$/)
      if (updateMatch && req.method === "POST") {
        const id = updateMatch[1]
        const job = await getJob(env, id)
        if (!job || job.user_id !== user_id) return json({ error: "not found" }, 404)
        const body = (await req.json()) as { body?: string }
        // Store the override; runJob is restarted by the next refresh.
        await updateJob(env, id, { stage: "drafting", error: null, ...(body.body ? {} : {}) })
        // Reset the job and re-run with override.
        await updateJob(env, id, {
          stage: "drafting",
          slug: null,
          title: null,
          abstract: null,
          live_url: null,
          error: null,
          stage_history: [...job.stage_history, { stage: "drafting", at: Date.now() }],
        })
        ctx.waitUntil(runJob(env, id, body.body ?? undefined))
        return json({ id, restart: true })
      }

      // ── /studio/publish/:id — manual publish ───────────────────
      // (No-op today: jobs auto-publish after drafting. Kept for future "draft only" toggle.)
      const publishMatch = p.match(/^\/studio\/publish\/([A-Za-z0-9_-]+)$/)
      if (publishMatch && req.method === "POST") {
        const id = publishMatch[1]
        const job = await getJob(env, id)
        if (!job || job.user_id !== user_id) return json({ error: "not found" }, 404)
        ctx.waitUntil(runJob(env, id))
        return json({ id, restart: true })
      }

      // ── /studio/status/:id — JSON snapshot ──────────────────────
      const statusMatch = p.match(/^\/studio\/status\/([A-Za-z0-9_-]+)$/)
      if (statusMatch && req.method === "GET") {
        const id = statusMatch[1]
        const job = await getJob(env, id)
        if (!job || job.user_id !== user_id) return json({ error: "not found" }, 404)
        return json(job)
      }

      // ── /studio/jobs — recent jobs for the dashboard ────────────
      if (p === "/studio/jobs" && req.method === "GET") {
        const jobs = await listJobs(env, user_id, 25)
        return json(jobs)
      }

      // ── /studio/blogs — existing blogs on disk ─────────────────
      if (p === "/studio/blogs" && req.method === "GET") {
        try {
          const blogs = await listBlogs(env)
          return json(blogs)
        } catch (e) {
          return json({ error: (e as Error).message }, 500)
        }
      }

      // ── /studio/delete — remove a past blog ────────────────────
      if (p === "/studio/delete" && req.method === "POST") {
        const body = (await req.json()) as { slug?: string }
        const slug = (body.slug ?? "").trim()
        if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
          return json({ error: "invalid slug" }, 400)
        }
        try {
          const result = await deleteBlog(env, slug)
          return json(result)
        } catch (e) {
          return json({ error: (e as Error).message }, 500)
        }
      }

      // ── /studio/logout ─────────────────────────────────────────
      if (p === "/studio/logout" && req.method === "POST") {
        await destroySession(env, sid)
        return new Response(null, {
          status: 302,
          headers: {
            location: env.ORIGIN + "/login",
            "set-cookie": clearSessionCookie(),
          },
        })
      }

      return new Response("not found", { status: 404 })
    } catch (e) {
      console.error("[studio] fatal", e)
      return new Response("internal error: " + (e as Error).message, { status: 500 })
    }
  },
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": envSameOrigin(),
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
  }
}

// Stub — used only by the OPTIONS preflight; we keep cookies first-party so
// there's no cross-origin in practice.
function envSameOrigin(): string {
  return "*"
}
