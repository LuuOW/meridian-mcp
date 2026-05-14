# Operations runbook

How to run, deploy, test, and recover this project without an AI in the loop.

The hardest-to-remember bits are at the top. Everything is copy-pasteable.

---

## Surface map

```
              host                            backed by                       deploy
  ─────────────────────────────────────────  ──────────────────────────────  ─────────────────────────
  ask-meridian.uk/                           landing/                        GH Pages — auto on push
  ask-meridian.uk/docs/                      landing/docs/                   GH Pages — auto
  ask-meridian.uk/blog/...                   landing/blog/                   GH Pages — auto
  ask-meridian.uk/miniapp/                   landing/miniapp/                GH Pages — auto

  meridian.ask-meridian.uk/helix/            helix/                          CF Pages — wrangler manual
  meridian.ask-meridian.uk/lens/             lens/                           CF Pages — wrangler manual
  meridian.ask-meridian.uk/miniapp/          miniapp/                        CF Pages — wrangler manual
  meridian.ask-meridian.uk/miniapp/vision-lab/   miniapp/vision-lab/         CF Pages — wrangler manual
  (legacy)  lens.ask-meridian.uk             zone redirect → /lens/          managed in CF zone rules

  photon.ask-meridian.uk/                    photon-route/pages/             standalone GH Pages — subtree push
  huggingface.co/spaces/luuow/photon-route   photon-route/                   workflow on push to monorepo main

  mcp.ask-meridian.uk/                       cf-worker/                      `cd cf-worker && wrangler deploy`
  api.ask-meridian.uk/                       api-worker/                     `cd api-worker && wrangler deploy`
  money.ask-meridian.uk/                     finance-mcp/                    `cd finance-mcp && wrangler deploy`
  botica.ask-meridian.uk/                    pharmacy-mcp/                   `cd pharmacy-mcp && wrangler deploy`

  vault.ask-meridian.uk/                     LuuOW/meridian-vault repo       SEPARATE repo, ignore from this one
```

---

## Deploys — exact commands

### Landing / blog / docs / GH-Pages-miniapp

```bash
git push origin main
```

GH Actions (`.github/workflows/pages.yml`) handles it. Anything under `landing/` triggers a redeploy. **No manual step.** Live in ~60s.

### CF Pages (helix / lens / miniapp / vision-lab)

```bash
bash site/build.sh
npx wrangler pages deploy site/dist --project-name=meridian-shared --commit-dirty=true
```

`site/build.sh` rebuilds `site/dist` from the four source dirs (helix/, lens/, miniapp/, miniapp/vision-lab/). The `--commit-dirty=true` flag tells wrangler not to refuse uncommitted local changes. The 28-file bundle goes up in ~3s.

**This is NOT auto.** If you change `helix/`, `lens/`, or `miniapp/` and don't run this, the live CF Pages stays stale.

### photon.ask-meridian.uk (standalone GH Pages)

```bash
SHA=$(git subtree split --prefix=photon-route -q HEAD)
git push https://LuuOW:${PAT}@github.com/LuuOW/photon-route.git "${SHA}:refs/heads/main"
```

Where `PAT` is fetched from keychain:

```bash
PAT=$(security find-generic-password -s "github-pat" -w)
```

**Why this is needed**: the monorepo's `sync-photon-route.yml` workflow pushes to the HF Space's *own* git (`huggingface.co/spaces/luuow/photon-route`), but `photon.ask-meridian.uk` is served by GitHub Pages from the *standalone* `LuuOW/photon-route` repo. The workflow doesn't update that repo. So any change touching `photon-route/pages/index.html` needs the subtree push above to reach the public domain.

### HF Space (photon backend at `luuow-photon-route.hf.space`)

Auto. The `.github/workflows/sync-photon-route.yml` workflow runs on every push to main that touches `photon-route/**` and pushes the subdir to HF.

### Workers

```bash
cd cf-worker && npx wrangler deploy   # mcp.ask-meridian.uk
cd api-worker && npx wrangler deploy  # api.ask-meridian.uk
cd finance-mcp && npx wrangler deploy # money.ask-meridian.uk
cd pharmacy-mcp && npx wrangler deploy # botica.ask-meridian.uk
```

Workers are isolated from each other. Deploying one doesn't affect the others.

---

## Nav across surfaces

The horizontal top bar / Apps dropdown / ⌘K palette / mobile burger / docs TOC is **one synced template**. To change any of it:

```bash
# Edit one of:
#   landing/_nav-data.json   — apps, resources, source links
#   landing/_nav.html        — HTML structure + inline wiring script
#   landing/nav.css          — shared stylesheet (loaded cross-origin)

python3 scripts/sync-nav.py
```

This walks every nav-bearing HTML under `landing/`, `helix/`, `lens/`, `miniapp/`, `photon-route/pages/`, replaces the `<nav class="nav">…</nav>` block, injects the cross-origin `<link rel="stylesheet" href="https://ask-meridian.uk/nav.css">` if missing, strips any leftover body-level `<style>` blocks, and regenerates the `__CMDK_INDEX__` JSON from the blog post titles + nav items.

You must run this before pushing if you've edited `_nav.html` or `_nav-data.json`. The CI workflow doesn't run it for you.

**To add a new app to the nav**: edit `landing/_nav-data.json`'s `showcase` array, run `python3 scripts/sync-nav.py`, commit + push (or also wrangler-deploy if the new app is on CF Pages).

---

## Tests

### Unit tests (Node)

```bash
npm test
# or:
node --test tests/*.test.mjs
```

48 tests across orbital classifier, skill-md parser, keystore, skills loader. Runs in <100 ms. CI gates this on every push + PR via `.github/workflows/ci.yml`.

### UI tests (Playwright, against live URLs)

```bash
npm run test:ui                                                    # both projects (desktop + Pixel 7 mobile)
npx playwright test --config=tests/ui/playwright.config.mjs \
    --project=desktop-chromium                                      # desktop only
npx playwright test --config=tests/ui/playwright.config.mjs tests/ui/nav.spec.mjs  # nav only
```

226 tests across 9 surfaces × 2 viewports. Runs against **live URLs** — if production is down, tests fail. First run downloads the Chromium binary (~90 MB cached at `~/.cache/ms-playwright`).

CI runs the suite after every successful `Deploy to GitHub Pages` workflow and daily at 07:13 UTC (`.github/workflows/ui-tests.yml`). On failure, the HTML report is uploaded as a workflow artifact named `playwright-report` (14-day retention).

**Reading a failure**: `test-results/<test-slug>-desktop-chromium/error-context.md` has the page snapshot + screenshot. `trace.zip` is the full Playwright trace — open via `npx playwright show-trace <path>`.

### Orbital classifier calibration simulation

```bash
node tests/sim/orbital-calibration.mjs
```

Generates 12 archetypal candidate templates (planet/asteroid/moon/comet/irregular across forge/signal/mind systems), runs each through `orbitalClassify` in 30 randomly-resampled 5-candidate batches, reports:

- archetype recall@1 (does each archetype get the expected class?)
- length→planet correlation (mass-driven length bias)
- sibling-perturbation stability

To experiment with retuning, edit `tests/sim/orbital-variant.mjs` (a sandbox copy of `classOf`), and the harness reports baseline vs variant side-by-side. The current `orbital-variant.mjs` is the 2026-05-14 retune that's now live.

---

## Cloudflare

### Inventory current resources

```bash
CF_EMAIL="lucas.kempe@icloud.com"
CF_KEY=$(security find-generic-password -s "cloudflare-global-api-key" -w)
H="-H \"X-Auth-Email: $CF_EMAIL\" -H \"X-Auth-Key: $CF_KEY\""

# Workers
curl -fsS $H "https://api.cloudflare.com/client/v4/accounts/aaa7edd5ef7330ebcd9dd875a1b9a3be/workers/scripts"

# Pages projects
npx wrangler pages project list

# DNS records on ask-meridian.uk zone
curl -fsS $H "https://api.cloudflare.com/client/v4/zones/6e04976960a13e188c7a74f7ff0000fd/dns_records?per_page=100"

# Zone redirect rules
curl -fsS $H "https://api.cloudflare.com/client/v4/zones/6e04976960a13e188c7a74f7ff0000fd/rulesets"

# KV namespaces
curl -fsS $H "https://api.cloudflare.com/client/v4/accounts/aaa7edd5ef7330ebcd9dd875a1b9a3be/storage/kv/namespaces"

# AI Gateway gateways
curl -fsS $H "https://api.cloudflare.com/client/v4/accounts/aaa7edd5ef7330ebcd9dd875a1b9a3be/ai-gateway/gateways"

# Vectorize indexes
curl -fsS $H "https://api.cloudflare.com/client/v4/accounts/aaa7edd5ef7330ebcd9dd875a1b9a3be/vectorize/v2/indexes"
```

**Account ID**: `aaa7edd5ef7330ebcd9dd875a1b9a3be`
**Zone ID** (ask-meridian.uk): `6e04976960a13e188c7a74f7ff0000fd`
**Documented redirect rule** (lens.ask-meridian.uk → /lens/): `45afee9ff83547b287b3a4e5991f754e`

### lens.ask-meridian.uk legacy subdomain

The DNS record `lens.ask-meridian.uk → meridian-shared.pages.dev` plus the zone-level Single Redirect Rule above keep the legacy URL alive. Don't delete either — old links and the cf-worker's `BROWSER_ORIGIN_ALLOWLIST` still reference it.

### Disable pharmacy-mcp.lucas-kempe.workers.dev (recommended)

`pharmacy-mcp` is the only Worker with its `workers.dev` subdomain enabled. It bypasses the Origin allowlist gate that `botica.ask-meridian.uk` enforces.

```bash
# Edit pharmacy-mcp/wrangler.toml and set:
#   workers_dev = false
cd pharmacy-mcp && npx wrangler deploy
```

---

## Security — credential locations & rotation

### Where credentials live (macOS keychain)

```bash
security find-generic-password -s "github-pat" -w                  # GitHub PAT, push access
security find-generic-password -s "cloudflare-global-api-key" -w   # CF Global API Key (FULL account access)
```

**The CF Global API Key has zero scoping** — it can transfer the domain, change billing, drop the zone. Rotate it after any shared session.

### Rotate the CF Global API Key

1. Go to `https://dash.cloudflare.com/profile/api-tokens`
2. Under "API Keys", click "View" next to "Global API Key" → enter password → "Roll"
3. Copy the new key
4. Update keychain:
   ```bash
   security delete-generic-password -s "cloudflare-global-api-key"
   security add-generic-password -a "lucas.kempe@icloud.com" \
       -s "cloudflare-global-api-key" -w "NEW_KEY"
   ```

**Better than rotating**: create a scoped API token at `https://dash.cloudflare.com/profile/api-tokens` with only the permissions you need (Zone:Read + DNS:Read + Workers:Edit + Pages:Edit for the read+deploy ops above), then delete the Global Key. Use the `Authorization: Bearer <token>` header instead of `X-Auth-Email + X-Auth-Key`.

### Enable 2FA on the Cloudflare account

`dash.cloudflare.com/profile/authentication` → enable TOTP. Save the recovery codes somewhere offline.

### Rotate the GitHub PAT

`github.com/settings/personal-access-tokens` → revoke + re-generate. Update keychain via `security add-generic-password -s "github-pat" …`.

---

## Releasing the npm package

```bash
# Bump version in package.json + finalise the CHANGELOG "Unreleased" header
git add package.json CHANGELOG.md
git commit -m "release: meridian-orbital@X.Y.Z"

git tag -a vX.Y.Z -m "meridian-orbital@X.Y.Z"
git push origin main vX.Y.Z

npm publish    # requires `npm login` first
```

The `mcpName` and binary names in `package.json` are stable across versions — clients pin by package version, not by binary name, so renames don't break configs.

---

## Common pitfalls (learned the hard way)

1. **photon.ask-meridian.uk goes stale after a `photon-route/pages/` edit**. The sync workflow pushes to HF Space, not to the standalone repo. Always subtree-push after touching that subdir (see "photon.ask-meridian.uk" above).
2. **CF Pages doesn't auto-deploy from this monorepo**. `bash site/build.sh && wrangler pages deploy site/dist --project-name=meridian-shared --commit-dirty=true` is mandatory after any change under `helix/`, `lens/`, `miniapp/` (the CF copy, not landing/miniapp).
3. **Cross-origin nav.css**. The shared nav stylesheet lives at `ask-meridian.uk/nav.css`. Surfaces on other origins (`meridian.ask-meridian.uk`, `photon.ask-meridian.uk`) load it via an absolute URL injected by `sync-nav.py`. If you change `landing/nav.css`, GH Pages must redeploy before the other surfaces pick up the new styles.
4. **Nav inline script collisions**. Both `landing/_nav.html` (synced everywhere) AND `landing/nav.js` used to wire the burger. nav.js's `initBurgerNav` stamped `btn.dataset.wired='1'` before the inline script ran, silently disabling Apps dropdown + ⌘K. nav.js is now a no-op stub for backwards compatibility; do not re-add wiring there.
5. **`/style.css` has dead nav rules**. `landing/style.css:76–446` defines `.nav`, `.burger`, `.nav-menu` etc. — overridden by the newer `nav.css` but still loaded. If you find yourself debugging a CSS conflict, check both files. (TODO: cleanup.)
6. **moon classification depends on dep_ratio, not on `hasParentInSet`**. The 2026-05-14 retune replaced the binary parent gate with a smooth `parent_pull = min(1.5, 0.3 + 1.7·dep_ratio)`. If you tune dep_ratio's amplifiers (`bestTokSim * 1.5, bestKwSim * 2.2`), expect cascading effects on moon recall. Always re-run `node tests/sim/orbital-calibration.mjs` after touching either file.
7. **CHANGELOG drift**. The README repeats the feature-vector dim (currently 25), the package version (currently 3.1.0 → 3.2.0), and the lens canonical URL. Update them when they change in code; the `landing/docs/index.html` page repeats some of the same numbers and is its own consistency hazard.
8. **`pages.yml` only redeploys when `landing/**` changes**. Touching root-level files like `README.md` or `CHANGELOG.md` won't redeploy GH Pages (and that's by design — nothing user-facing changed). If you need to force a redeploy, use `workflow_dispatch` from the Actions UI or push a no-op landing/ change.

---

## Where to look when something breaks

- **GH Pages didn't update**: Actions tab → `Deploy to GitHub Pages` run for the commit. Logs include the `dist/` listing.
- **UI tests went red**: Actions tab → `UI tests (Playwright)`. Download the `playwright-report` artifact, open `index.html`.
- **CF Pages says "Deployment failed"**: `npx wrangler pages deployment list --project-name=meridian-shared` for recent deploys; `npx wrangler tail --project-name=meridian-shared` for runtime logs.
- **Worker is 5xx-ing**: `cd cf-worker && npx wrangler tail` (or whichever worker dir). Streams live logs.
- **A photon route or HF Space is stale**: check `LuuOW/photon-route` HEAD vs the monorepo's `photon-route/` subtree SHA (`git subtree split --prefix=photon-route -q HEAD`). If they differ, run the subtree push.
- **Orbital classifier is misclassifying**: run `node tests/sim/orbital-calibration.mjs`, compare to the calibration report in `CHANGELOG.md` (look for the 2026-05-14 entry's "Results" panel).

---

## Simulations — measuring app quality

Each app has a sim under `tests/sim/` that talks to the live deployed surface
and reports a quality metric. Re-runnable. Outputs no artifacts (logs to
stdout only) so they can be piped to a file or compared between runs.

### Orbital classifier — `tests/sim/orbital-calibration.mjs`

```bash
node tests/sim/orbital-calibration.mjs
```

Generates 12 archetypal candidate templates × 30 sibling-resampled batches
each. Reports archetype recall@1, length→class correlation, and stability.
**No network**; runs fully offline against the local `orbitalClassify`.

To prototype a new `classOf` retune: edit `tests/sim/orbital-variant.mjs`
and the harness prints baseline-vs-variant side-by-side. See the
2026-05-14 CHANGELOG entry for the last calibration.

### Helix recommendation quality — `tests/sim/helix-quality.mjs`

```bash
node tests/sim/helix-quality.mjs                      # default 30s gap, 1 trial per injury
HELIX_SIM_TRIALS=3   node tests/sim/helix-quality.mjs # 3 trials per injury (variance)
HELIX_SIM_GAP_MS=60000 node tests/sim/helix-quality.mjs # paid-token mode: 60s gap
```

Calls live `mcp.ask-meridian.uk/v1/helix` with a 19-injury hand-curated gold
set (each injury → ordered list of expected UniProt IDs from the
SEED_PROTEINS table). Reports nDCG@5, recall@{1,3,5}, precision@1, and a
negative-control hit rate (how often IL-8 wrongly surfaces in top-3 —
should be 0%).

**Quota awareness:** GH Models free tier rate-limits aggressively
(~10 req/min, with longer-window daily caps). The default 30 s gap stays
under the per-minute bucket, but a full 19-injury run can still hit a
daily cap if you've burned the budget earlier. If the script reports
`HTTP 429` repeatedly, wait an hour and rerun — or set
`MERIDIAN_GITHUB_TOKEN` on the Worker to a paid token.

### Photon-route held-out evaluation

The trained encoder has historically overfit because train and test were
the same 6-query set. The fix is a chronological split:

```bash
cd photon-route

# 1. Expand the relevance set (one-shot, needs network — scrapes arXiv titles)
python -m eval.expand_titles --out eval/relevance_expanded.json

# 2. Split chronologically by the youngest relevant doc per query
python -m eval.split_holdout \
    --in eval/relevance_expanded.json \
    --train-cutoff 2018 --val-cutoff 2020

# 3. Retrain on train + early-stop on val (runs on the HF Space's 16 GB CPU,
#    NOT on the meridian-vm)
python -m space.train \
    --relevance eval/relevance_train.json \
    --val-relevance eval/relevance_val.json \
    --out weights_holdout.npz

# 4. Report TEST-only metrics. This is the number to publish.
python -m eval.run \
    --weights weights_holdout.npz \
    --relevance eval/relevance_test.json
```

The split script writes `relevance_{train,val,test}.json` next to the source
file. The eval script `eval/run.py` already accepts `--relevance` so the
test-only run is a drop-in.

**Don't trust train==test metrics.** The user-memory note on this is
specific: `nDCG 0.747` on train==test collapsed to `0.071` on holdout
before the splitter existed. Always read the test-only number.

---

## Working flow — branches, PRs, and the recurring sims

Main is now branch-protected: direct pushes blocked, PR + passing CI
required. Solo workflow:

```bash
git checkout -b <topic-branch>           # e.g. feat/lens-non-xr
# ... edit + commit ...
git push -u origin <topic-branch>

# Open the PR (one of these works depending on what's installed):
gh pr create --fill                                 # if gh CLI is installed
# OR via the GitHub API:
PAT=$(security find-generic-password -s "github-pat" -w)
curl -fsS -X POST \
  -H "Authorization: Bearer $PAT" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/LuuOW/meridian-mcp/pulls" \
  -d '{"title":"...","body":"...","head":"<topic-branch>","base":"main"}'
```

Wait for the `CI / test (20)` and `CI / test (22)` checks (~30 s).
Once green, squash-merge through the UI or:

```bash
gh pr merge --squash --auto
```

**Escape hatch:** branch protection has `enforce_admins: false`, so you
can disable protection from the dashboard for hotfixes. Re-enable
after pushing.

**Bots** (the `sim-orbital` / `sim-helix` / `classifier-health`
workflows) push direct to main; the workflows' fallback branch creates
a PR + auto-merges if a direct push is ever rejected.

### Recurring sim artifacts

| Workflow | Schedule | Output |
|---|---|---|
| `.github/workflows/sim-orbital.yml` | Tue + Fri 06:11 UTC | `data/sim-reports/orbital-YYYY-MM-DD.txt` |
| `.github/workflows/sim-helix.yml`   | Wed 08:17 UTC       | `data/sim-reports/helix-YYYY-MM-DD.txt` |
| `.github/workflows/sim-photon.yml`  | manual (`workflow_dispatch`) | `data/sim-reports/photon-YYYY-MM-DD-{v1,v2}.json` |
| `.github/workflows/ui-tests.yml`    | after every Pages deploy + daily 07:13 UTC | failure → `playwright-report` artifact (14d retention) |
| `.github/workflows/classifier-health.yml` | Mon 06:00 UTC | `landing/healthz.json` |

Each automated run = one contribution on the graph + one comparable
data point in `data/sim-reports/`. Open the latest two for any
classifier metric and spot drift in seconds.

---

## Backlog (not scoped to this session)

- **Lens non-XR fallback.** Pointer-lock + mouse-look controller that
  drives the same `vlm.mjs` / `meridian-route.mjs` flow without a
  headset. Multi-day rewrite (new controller, viewport capture, UI
  affordance). Today's gate page is sane for headset users but is a
  dead end for everyone else.
- **Cleanup of dead nav CSS** in `landing/style.css:76-446`,
  `helix/helix.css:33-138`, `miniapp/miniapp.css:.nav-links` rules.
  All overridden by the newer cross-origin `nav.css` but still loaded.
- **More SEED_PROTEINS in helix.** Currently 10 hand-curated entries,
  expansion needs domain expertise + UniProt accession verification.
