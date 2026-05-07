# Changelog

## [2.1.0] — 2026-05-07

**Remote MCP variants — Streamable HTTP transports for hosts that need a
server URL (Grok connectors, ChatGPT custom MCPs, Claude.ai connectors).
Stdio entrypoint unchanged; existing `meridian-mcp` users see no
breakage.**

### Added
- `mcp/_lib/core.mjs` — shared LLM-call + classify + format core,
  callable from both transports. Token is per-call (no longer env-only),
  so the HTTP variant can pass through bearer tokens or use a server
  PAT. `process.env`-tolerant for runtimes without `process` (Workers,
  browsers).
- `mcp/http.mjs` + `meridian-mcp-http` bin — Node Streamable-HTTP server
  for self-hosters. Stateless, bearer-pass-through by default, optional
  shared-key gateway mode.
- `cf-worker/` — hosted variant at **`https://mcp.ask-meridian.uk/mcp`**
  with full OAuth 2.1 + PKCE flow, KV-backed opaque access tokens, and
  a one-click authorize page. Operator-pays auth model: the Worker
  holds a single `MERIDIAN_GITHUB_TOKEN` secret and uses it for every
  inference call so end users see no GitHub jargon.
- Connector icon served at `/favicon.svg`, `/icon.svg`, `/logo.svg` and
  advertised via `logo_uri` in OAuth AS metadata + `_meta.iconUrl` in
  MCP serverInfo so connector hosts can render the brand.
- `.github/workflows/deploy-worker.yml` — auto-deploys the Worker on
  every push to `main` that touches `cf-worker/**` or `mcp/_lib/**`.
- Docker mode toggle: `MCP_MODE=http` runs the Node HTTP server instead
  of stdio.

### Changed
- `mcp/index.mjs` (stdio) refactored to delegate to `_lib/core.mjs`.
  No behavior change.
- README: new "Use as a Grok connector" section with the OAuth values.

## [2.0.0] — 2026-05-06

**Self-contained MCP. The Cloudflare backend was retired during the GitHub
Pages migration; `1.0.1` POSTs to a dead endpoint. `2.0.0` collapses the
architecture into the npm package itself.**

### Added
- `mcp/_lib/` — bundled orbital classifier (orbital.mjs, tokenize.mjs,
  systems.mjs). Identical code to `landing/_lib/` so the browser and the
  npm package share one classifier.
- GitHub Models integration. Default model `meta/llama-3.3-70b-instruct`.
- New env vars: `MERIDIAN_GITHUB_TOKEN` (or `GITHUB_TOKEN`),
  `MERIDIAN_MODEL`, `MERIDIAN_MODELS_ENDPOINT`, `MERIDIAN_CANDIDATES`.
- `.github/workflows/publish.yml` — tag-driven dual-registry publish to
  both the public npm registry (as `meridian-skills-mcp`) and GitHub
  Packages (as `@luuow/meridian-skills-mcp`).

### Changed
- Wall time per call: 30–50 s → **5–15 s** (no extra hop, GitHub's
  inference is quicker than Workers AI was).
- Output shape unchanged. Drop-in replacement for `1.x` once
  `MERIDIAN_GITHUB_TOKEN` is set.

### Removed
- `MERIDIAN_API_URL`, `MERIDIAN_API_KEY` env vars (no backend to point at).
- Tests for retired CF Pages Functions: `ai-gateway`, `ip-allowlist`,
  `kv`, `stream`, `vector`, `system-terms`. The remaining 46 tests pass.

### Migration from `1.x`
1. Generate a GitHub PAT with `Models: read` permission.
2. `export MERIDIAN_GITHUB_TOKEN=...` (or rely on `GITHUB_TOKEN`).
3. `npm install -g meridian-skills-mcp@latest`.
4. No agent prompt changes needed.

## [1.0.0] — 2026-05-01

**Major architecture flip — the MCP becomes a thin stdio→HTTP client over the same backend the public miniapp uses.**

### Added
- New `mcp/index.mjs` — single 5 KB stdio client.
- Backend `POST /api/orbital-route` (Cloudflare Pages Function) — calls Workers AI Llama-3.3-70B to generate candidate skills, then runs an open-domain orbital classifier in JS.
- Open-domain classifier (`landing/functions/api/_orbital.js`): physics signature derivation (mass, scope, independence, cross_domain, fragmentation, drag, dep_ratio, lagrange_potential) from text content alone — no curated lookup table needed. Class assignment by argmax over six per-class scores.
- Star-system membership inference from `forge` / `signal` / `mind` term sets (lifted verbatim from `skill_orbit.py`).
- New configuration env vars: `MERIDIAN_API_URL`, `MERIDIAN_API_KEY`, `MERIDIAN_TIMEOUT_MS`.

### Changed
- **No local model.** No `@xenova/transformers`, no Python, no bundled SKILL.md corpus.
- Tarball: 320 KB → **4.5 KB** (99% smaller). 110 files → 4 files. 6 deps → 1 dep (`@modelcontextprotocol/sdk`).
- Single tool: `route_task(task, limit?)`. Tools `get_skill`, `list_skills`, `search_skills` removed — they were a closed-domain abstraction that has no meaning under dynamic LLM generation.
- Each call: ~30–50 s wall time (Llama-3.3-70B authoring time). Default `MERIDIAN_TIMEOUT_MS` of 90 s accommodates this.
- Internet required (was offline-capable in 0.3.x).

### Removed
- `src/server.mjs`, `src/skills.mjs`, `src/embeddings.mjs`, `src/miniapp.mjs`, `src/keystore.mjs`, `src/market.mjs`, `src/setup-stripe.mjs`, `src/stripe-helper.mjs`.
- `skills/` (88 SKILL.md curated corpus) and `skills/skill_orbit.py` from the published tarball. Repo retains them for legacy use.
- Stripe checkout, World ID gating, ethers/blockchain market, the `/api/mcp` HTTP MCP transport, the `mrd_live_` API key system.

### Migration note
Pin `meridian-skills-mcp@0.3.2` if you need offline routing or the closed-domain curated corpus path.

---

## [0.3.2] — 2026-05-01

### Fixed
- Published tarball now includes `skills/skill_orbit.py` (was excluded in 0.3.1 because the file existed at `/opt/skills/` rather than in the repo at the time of the 0.3.1 release tag). `route_task` was previously failing with ENOENT on a fresh install. Verified post-publish: `tar -tzf … | grep orbit` now returns `package/skills/skill_orbit.py`.

## [0.3.1] — 2026-04-16

### Changed
- Skill corpus curation: keyword sets, `orb_class` assignments, `audit` toolchain in `scripts/`.

## [0.3.0] — 2026-04-16

### Added
- Skills corpus self-contained in the repo (`skills/<slug>/SKILL.md`), no longer dependent on `/opt/skills` at the consumer site.

## [0.2.0] — 2026-04-16

### Added
- **Semantic embedding layer** (`all-MiniLM-L6-v2` via `@xenova/transformers`): pre-ranks all skills by cosine similarity before orbital physics scoring. Runs on CPU, model cached after first load (~23 MB).
- `--candidates` flag in `skill_orbit.py`: orbital scorer now accepts a pre-filtered slug list from the embedding layer, improving both speed and accuracy.

### Changed
- Default routing limit raised from 5 → 7 — cross-domain queries now surface all relevant skills.
- `monitoring` profile: added `monitors`, `watches`, `anomaly`, `risk`, `depeg`, `drift` — fixes plural/verb form matching.
- `defi` profile: added `stablecoins`, `oracle`, `collateral`, `price feed`, `on-chain`, `wld`.
- `agents` profile: added `monitor`, `automation`, `pipeline`, `orchestration`, `watchdog`.

### Fixed
- `monitors` (verb form) was not matching the `monitor` keyword due to word-boundary regex — now covered explicitly.
- Cross-domain queries (e.g. "autonomous agent monitors stablecoin depeg risk") now surface `observability` and `defi-protocols` alongside `agent-loop`.

## [0.1.1] — 2026-04-15

### Changed
- Switched hosted endpoint to clean subdomain: `https://api.ask-meridian.uk/mcp` (was `/api/mcp`).
- Documentation now at `https://docs.ask-meridian.uk` (sidebar nav, MCP-native).
- Trading dashboard moved to `https://bot.ask-meridian.uk` (legacy `/app/` still works).

## [0.1.0] — 2026-04-15

Initial public release.

### Added
- stdio MCP transport (for `claude mcp add meridian meridian-mcp`)
- HTTP Streamable MCP transport (hosted, auth via `mrd_live_` keys)
- Four tools: `route_task`, `get_skill`, `list_skills`, `search_skills`
- 73 skills exposed as MCP resources (`meridian://skills/<slug>`)
- Stripe Checkout integration + webhook auto-provisioning
- Example skills in `example-skills/`
- MIT license
