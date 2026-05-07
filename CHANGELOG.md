# Changelog

## [2.2.2] — 2026-05-07

**Bootstrap CI replaced with Wilson score interval — 2.2.1's bootstrap was under-covering at high p.**

### Findings

A 5-method coverage simulation (`scripts/simulate-ci-methods.mjs`,
5,000 trials × 5 true rates × 5 CI methods) revealed:

| true p | bootstrap | wilson | clopper-pearson | jackknife | bayes |
|---|---|---|---|---|---|
| 0.50 | 0.921 | 0.918 | 0.971 | 0.918 | 0.971 |
| 0.81 | 0.899 | **0.954** | 0.978 | 0.922 | 0.954 |
| 0.95 | **0.666** | **0.981** | 0.981 | 0.665 | 0.915 |

At the true rate where our recall@5 sits (p≈0.95), the bootstrap and
jackknife CIs only contained the truth 66.6% / 66.5% of the time —
both under-cover at extreme p. Wilson and Clopper-Pearson stayed at
nominal 95% coverage across the whole range.

### Changed

- **`eval-against-public-data.mjs`** — replaced 10,000-resample
  bootstrap with closed-form Wilson score interval. Zero compute,
  better-calibrated coverage. Bootstrap kept in `simulate-ci-methods.mjs`
  for comparison purposes.
- **`_update-healthz.mjs`** — `bootstrap_resamples` field replaced
  with `ci_method: "wilson"`.
- **Blog post + landing copy + README** — recall now cited as
  `81% [95% Wilson CI 60%, 92%]` (was `[62%, 95%]` from bootstrap).
  recall@5 now `[77%, 99%]` (was `[86%, 100%]` — bootstrap was much
  too narrow on the upper bound).

### Lesson

Monte Carlo is the universal numerical method — but for a binomial
proportion `k/n`, an 18-line closed-form expression (Wilson 1927)
has nominal coverage at zero compute. Don't reach for the universal
hammer when a proportion is staring you in the face.

## [2.2.1] — 2026-05-07

**Honest error bars on the published recall numbers — bootstrap 95% CI from 10,000 resamples (Bell & Glasstone §1.6e Monte Carlo for expectation values from a small sample).**

### Added

- **`scripts/eval-against-public-data.mjs`** now computes 95% bootstrap CI on
  recall@1 and recall@5 for v2, trivial baseline, and random. 10,000 resamples
  with replacement on the n=21 labelled rows.
- **Healthz JSON** now records `recall_at_1_ci_95` and `recall_at_5_ci_95`
  (lo/hi/mean) so the weekly cron tracks regression on the *lower bound*, not
  just the point estimate.
- **`scripts/stress-test-classifier.mjs`** + baseline JSON — 6 stress tests
  (length-perturb, keyword-perturb, sibling-isolation, adversarial inputs,
  confusion matrix, candidate-set jitter) with regression bounds.
- **`scripts/simulate-classifier-breit-wigner.mjs`** + **`simulate-classifier-branching.mjs`** —
  two more diagnostic-only physics-framing receipts (Bell & Glasstone §8.1
  resonance + §8.2b decay channels). Both confirmed: textbook physics doesn't
  improve the SKILL/TASK → physics-vector encoding bottleneck. Same pattern as
  CRTBP / spectral / v2+CRTBP.

### Changed

- **Verdict logic** in the eval script now uses CI separation (lower-bound vs
  upper-bound) instead of raw hit-count diff. With n=21 a 2-hit lead means
  nothing, so the old "v2 beat trivial by 2 hits" verdict was overconfident.
- **Blog post + landing copy + README** now cite `81% [95% CI 62%, 95%]`
  instead of bare `81%`. Honest framing: v2 unambiguously beats random
  (random's upper bound is 29%), but its CI overlaps with trivial's
  ([0.52, 0.90]) — we cannot claim a 10pp lead is real until we have more
  labelled rows.

### Findings

- v2 r@1 = 0.810 [0.619, 0.952]
- v2 r@5 = 0.952 [0.857, 1.000]
- trivial r@1 = 0.714 [0.524, 0.905]   — overlaps with v2 CI
- random r@1 = 0.143 [0.000, 0.286]    — clearly below v2's lower bound

## [2.2.0] — 2026-05-07

**Classifier learning loop — every browser engagement is now a pairwise-ranking SGD step on top of the heuristic. The orbital classifier improves from real user clicks without any local training.**

### Added

- **Online SGD layer** in `cf-worker/online_learning.mjs` — feature extraction
  (24-dim vector per skill: 8 physics scalars + 6 class one-hot + 3 star-system
  one-hot + 4 token-hit + 4 ranking features), pairwise-ranking SGD with
  logistic loss + L2 shrinkage, KV-backed weights blob.
- **`POST /v1/feedback`** endpoint on the worker. Front-ends
  (lens, miniapp, photon, vision-lab) POST `{query, selected[], chosen_slug, action}`.
  Worker pulls weights, runs one SGD step against (chosen, every-other) pairs,
  writes back. Constant-time per request (~1 ms). Origin-allowlisted same as `/v1/route`.
- **`GET /v1/model-info`** — read-only model state for dashboards + the
  eval cron. Returns `{version, n_updates, n_pairs, cold_start, updated_at}`.
- **Fitted correction in `/v1/route`** — `final_score = heuristic × (1 + tanh(K · w·x))`,
  bounded to [0, 2]. Cold start (`w = 0`, multiplier = 1) means day-1
  deployments use pure heuristic; weights drift as feedback accumulates.
  The OAuth-gated `/mcp` endpoint stays heuristic-only for connector determinism.
- **`scripts/calibrate-classifier.mjs`** + a baseline panel + four simulation
  scripts (`simulate-classifier-v2.mjs` / `crtbp` / `spectral` / `v2-with-crtbp`)
  that produced the v2 retune. CRTBP and spectral were diagnostic-only —
  documented in the [blog post](https://ask-meridian.uk/blog/orbital-classifier-online-learning/).
- **`scripts/eval-against-public-data.mjs`** — runs v2 against `shawhin/tool-use-finetuning`
  via the HF datasets-server (no auth). Recall@1 = 0.810, recall@5 = 0.952.
  Two baselines: trivial token-overlap = 0.714, random = 0.095.
- **`.github/workflows/classifier-bootstrap.yml`** — cron every 3 days,
  feeds labelled examples from the HF benchmark into `/v1/feedback` so the
  fitted weights train without organic traffic.
- **`.github/workflows/classifier-health.yml`** — cron Mondays, re-runs the
  benchmark and writes `landing/healthz.json` with current recall + model state.
  Drift catches regressions automatically.

### Changed

- `mcp/_lib/orbital.mjs` — formula updates validated by the simulation
  pipeline before any production change:
  - `mass`: log-scaled across realistic LLM body lengths [200, 3000] chars
    and [3, 12] keywords. Was saturating at ~0.95 because Llama-3.3-70B
    emits longer/denser bodies than the formula was tuned for.
  - `scope`: drop the 0.25 floor; saturation cap moves from kws/14 → kws/12.
  - `planet_score`: switch from product to `min(mass, scope, indep)^1.5`.
    A deficit on any single axis now disqualifies planet (anchor-skill
    semantics: "strong on every dimension," not "strong on average").
  - `asteroid_score`: threshold 0.4 → 0.55 to match the new mass distribution.
  - `wavelength`: replace mass-dominated formula (clustered at 600 nm) with
    a two-axis `redPull − bluePull` so the full visible band is reachable.

  Calibration panel: class accuracy 0.167 → 0.500, 4 classes used (was 2),
  mass + scope discrimination both recovered above 0.5.

### Reframed

- Public-eval finding: against `shawhin/tool-use-finetuning` (21 single-tool
  rows), the v2 classifier hits **0.810 recall@1, 0.952 recall@5** — 8.5×
  above random, 10pp above trivial token-overlap. The synthetic 18-skill
  panel is harder than real-world tool routing (designed to stress-test class
  boundaries); production is much closer to 81% than to 50%.

### Deprecated

- `/api/orbital-route` references swept from `landing/style.css`,
  the orbital-classifier blog post, and miniapp file headers. That endpoint
  hasn't existed since the Cloudflare Pages Function was retired in 1.x;
  canonical paths are `/mcp` (OAuth, connector hosts) and `/v1/route`
  (browser, first-party Meridian sub-properties).

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
