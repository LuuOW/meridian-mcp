# meridian-studio

Passkey-authenticated Cloudflare Worker that drafts, banners, and publishes
arXiv briefings to `ask-meridian.uk/blog/` in one shot.

Live at **https://studio.ask-meridian.uk** (after `wrangler deploy`).

## What it does

```
┌─────────────────────────────────────────────────────────────────────┐
│ /studio dashboard                                                    │
│                                                                     │
│   arXiv URL or id:  [2606.23614                            ]        │
│   body (optional):  [<p>...</p>                             ]        │
│                                                                     │
│   [ Create & publish ]                                              │
└────────────────┬────────────────────────────────────────────────────┘
                 │
                 ▼
   ┌────────────────────────────────────────────────────┐
   │ Stages (polled every 3s)                          │
   │                                                    │
   │  queued → fetching → drafting → banner            │
   │                              → committing          │
   │                              → pushing             │
   │                              → deploying           │
   │                              → live                │
   └────────────────────────────────────────────────────┘
                 │
                 ▼
   https://ask-meridian.uk/blog/<slug>/  (within ~30–60 s of clicking publish)
```

Each blog gets:

- `landing/blog/<slug>/index.html` — full post with paper button, lead,
  banner, body, listen.js player, and the KaTeX auto-render (including the
  `\[...\]` display-math delimiter so equations render).
- `landing/img/blog/<slug>-banner.svg` — dark-technical banner matching
  the rest of the blog's visual language. **Editable in the dashboard
  before publishing** via the `studio/banner-editor` route (coming).
- A new card on `landing/blog/index.html` so the post shows up on `/blog/`.

The studio is **destructive** in the sense that it commits straight to
`main` on `LuuOW/meridian-mcp`. For a single-tenant blog that pages via
GitHub Pages on every push, that's the right tradeoff — no PR queue, no
branch drift. A future GitHub App integration can switch this to PRs
without changing the studio UI.

## Reuse, not reinvention

| Piece | Comes from |
| --- | --- |
| WebAuthn ceremony (passkey register / authenticate) | [`finance-mcp/src/webauthn.ts`](../finance-mcp/src/webauthn.ts) — copied and retargeted at STUDIO_KV |
| KV storage primitives (passkey, challenge, session, reg-link) | [`finance-mcp/src/storage.ts`](../finance-mcp/src/storage.ts) — same key layout, dropped the finance-tool fields |
| Slug, banner pattern, index card shape | Hand-derived from the 30+ posts already in `landing/blog/` |
| LinkedIn cadence (not in this worker yet) | [`/Users/lkempe/.codex/skills/blog-creator/references/style.md`](../../.codex/skills/blog-creator/references/style.md) |

## Routes

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| GET    | `/` | status (counts passkeys) | public |
| POST   | `/admin/create-registration-link` | mint one-time URL | `X-Admin-Secret` |
| GET    | `/register/:token` | passkey registration page | one-time link |
| POST   | `/register/:token/options` | WebAuthn registration options | one-time link |
| POST   | `/register/:token/verify` | verify + store passkey, **destroy link** | one-time link |
| GET    | `/login` | login page (passkey prompt) | public |
| POST   | `/login/options` | WebAuthn auth options | `?key=` |
| POST   | `/login/verify` | verify, set `studio_sid` cookie | `?key=` |
| GET    | `/studio` | dashboard | session cookie |
| POST   | `/studio/create` | start a job | session cookie |
| POST   | `/studio/update/:id` | supply body override before commit | session cookie |
| POST   | `/studio/publish/:id` | manual re-publish (no-op today) | session cookie |
| GET    | `/studio/status/:id` | JSON snapshot | session cookie |
| GET    | `/studio/jobs` | JSON list (newest 25) | session cookie |
| GET    | `/studio/blogs` | JSON list of existing posts | session cookie |
| POST   | `/studio/delete` | delete `{slug}` | session cookie |
| POST   | `/studio/logout` | clears session cookie | session cookie |

## Job stages

| Stage | What happens |
| --- | --- |
| `queued` | row in KV with arxiv id, waiting for the worker |
| `fetching` | pulling arxiv.org/abs/... — extracts title, authors, abstract, primary subject |
| `drafting` | composeDraft() builds slug, lead, body paragraphs, banner SVG, index card |
| `banner` | banner SVG generated (server-side, dark-technical style) |
| `committing` | three GitHub Contents API PUTs: banner, page, optional index card |
| `pushing` | the Contents API commits go straight to main; this stage is short |
| `deploying` | polls `https://ask-meridian.uk/blog/<slug>/` every 5s for up to 5 minutes |
| `live` | 200 OK from the deployed page |
| `failed` | any stage above failed; `error` field on the job row explains why |

Each row in KV carries a `stage_history` array with timestamps, so the
dashboard can show the timeline of every job.

## Deploy

```bash
cd studio-worker
npm install
npm run typecheck

# 1) Create the KV namespace
npx wrangler kv namespace create STUDIO_KV
# Paste the returned id into wrangler.toml [[kv_namespaces]] binding = "STUDIO_KV"

# 2) Set secrets
npx wrangler secret put ADMIN_SECRET       # any long random string
npx wrangler secret put GITHUB_TOKEN       # PAT scoped to contents:write on LuuOW/meridian-mcp

# 3) Configure the route — bind a custom subdomain
# (already in wrangler.toml: studio.ask-meridian.uk)

# 4) Deploy
npx wrangler deploy
```

The Pages workflow in `.github/workflows/pages.yml` already watches
`landing/**`, so any commits the studio makes to `landing/` automatically
trigger a Pages deploy. No additional wiring needed.

## Bootstrap your first passkey

```bash
ORIGIN="https://studio.ask-meridian.uk"
ADMIN_SECRET="<the secret you set>"

curl -sX POST -H "X-Admin-Secret: $ADMIN_SECRET" \
  $ORIGIN/admin/create-registration-link
# → { "url": "https://studio.ask-meridian.uk/register/<token>", "expires_in": 3600 }
```

Open that URL on the device with the passkey (Mac / iPhone / Android /
hardware key). Click *Register passkey*, do the biometric. The URL
self-destructs and `/studio` is now unlocked for that passkey.

For day-to-day use: visit `/login`, tap your passkey, dashboard unlocks.

## Local dev

```bash
# .dev.vars
ADMIN_SECRET=hello
GITHUB_TOKEN=DRY-RUN
```

`GITHUB_TOKEN=DRY-RUN` switches the GitHub Contents client into a no-op
mode that just logs the would-be commit shas. The full pipeline still
runs, so you can exercise `fetching → drafting → banner → committing →
live` without ever touching GitHub.

```bash
npm install
npx wrangler dev --port 8787 --local

# in another terminal:
ORIGIN=http://127.0.0.1:8787 ADMIN_SECRET=hello \
  node scripts/create-link.mjs
```

## Threat model

- **Single-tenant.** `USER_ID` is hardcoded to `lucas`. Bootstrap refuses
  to mint a new registration link once any passkey is bound.
- **Passkey-only.** No password fallback, no email link, no recovery
  flow. If you lose the passkey you have to mint a fresh
  `/admin/create-registration-link` and either append to the existing
  passkey list (TODO) or rotate the user.
- **GitHub PAT is the only publishing credential.** It lives in the
  Worker secret store, scoped to `contents:write` on this repo. Rotate
  it via `wrangler secret put GITHUB_TOKEN`; the old one stops working
  at the GitHub side within seconds.
- **Session cookies are HttpOnly + Secure + SameSite=Strict, scoped to
  Path=/studio.** They never leak to the public site.
- **No multi-tenant separation in this iteration.** If you need to
  onboard a second user, swap `GITHUB_TOKEN` for a GitHub App
  installation token (1h TTL, scoped to the user's repos). The studio
  UI doesn't need to change.

## Files

```
src/
  storage.ts     KV primitives — sessions, challenges, registration links, jobs
  webauthn.ts    WebAuthn register / authenticate (copied from finance-mcp, retargeted at STUDIO_KV)
  arxiv.ts       arXiv fetcher + slug helper
  draft.ts       Composer: lead, body paragraphs, banner SVG, post HTML
  github.ts      Contents API publisher (publish / deleteBlog / listBlogs) + DRY-RUN shim
  deploy.ts      Polls ask-meridian.uk/<slug>/ until it returns 200
  pages.ts       HTML for registration / login / status pages
  index.ts       Worker entry, route table, dashboard HTML
wrangler.toml
package.json
tsconfig.json
scripts/create-link.mjs
```
