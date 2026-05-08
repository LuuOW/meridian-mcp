# Meridian MCP

**Dynamic task routing via orbital mechanics. Domain-agnostic — candidates can be tools, prompts, documents, products, or any routable entity.**

Self-contained MCP — stdio for local hosts (Claude Code, Cursor, Windsurf…) and Streamable HTTP for remote connectors (Grok, ChatGPT custom MCP, anything that takes a server URL). Generates candidates with Llama-3.3-70B (via [GitHub Models](https://github.com/marketplace/models)) and ranks them with a local orbital classifier into celestial body classes (`planet`, `moon`, `trojan`, `asteroid`, `comet`, `irregular`).

[![npm](https://img.shields.io/npm/v/meridian-orbital.svg)](https://www.npmjs.com/package/meridian-orbital)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **3.0 — renamed from `meridian-skills-mcp`.** The classifier was always domain-agnostic; the "skills" framing biased the LLM prompt toward AI-agent capabilities. v3 drops that framing across the prompt, code, branding, and npm name. Migration: `npm i -g meridian-orbital` (the old package is deprecated; both binaries are still named `meridian-mcp` / `meridian-mcp-http` so client configs keep working). The hosted HTTP MCP at `mcp.ask-meridian.uk/mcp` continues to work — URL unchanged.

## Install (stdio — Claude Code / Cursor / Windsurf)

```bash
npm install -g meridian-orbital
claude mcp add meridian meridian-mcp
```

Same install works in Cursor, Windsurf, Goose, Continue, and any MCP client that speaks stdio.

You'll need a GitHub personal access token with the `Models: read` permission (free tier). Generate one at https://github.com/settings/personal-access-tokens/new and export it:

```bash
export MERIDIAN_GITHUB_TOKEN=github_pat_...
```

(The MCP also picks up plain `GITHUB_TOKEN` if you have one already in your environment.)

## Use as a Grok connector

A hosted Streamable-HTTP variant lives at **`https://mcp.ask-meridian.uk/mcp`** with full OAuth 2.1 + PKCE so it slots into any host that requires a connector URL — Grok's custom MCP connectors, ChatGPT custom MCPs, Claude.ai connectors. No npm install, no PAT entry from your side, no infra.

In Grok's "Add custom connector" dialog, paste these:

| Field | Value |
|---|---|
| **Server URL** | `https://mcp.ask-meridian.uk/mcp` |
| **Authorization endpoint** | `https://mcp.ask-meridian.uk/authorize` |
| **Token endpoint** | `https://mcp.ask-meridian.uk/token` |
| **Client ID** | `grok` |
| **Client secret** | *(empty)* |
| **Token auth method** | `none` (PKCE only) |
| **Scopes** | `route_task` |

When you click "Authorize" in Grok, it opens [`/authorize`](https://mcp.ask-meridian.uk/authorize) — a one-click confirmation page (no PAT pasting, no GitHub jargon). Inference runs against [GitHub Models](https://github.com/marketplace/models) using the operator's PAT, so end users see zero friction. Tokens last 1 hour and can be reauthorized any time.

The same URL works for **ChatGPT custom MCPs** and **Claude.ai connectors** — they speak the same MCP Streamable HTTP + OAuth 2.1 spec.

### Self-hosting the HTTP variant

If you'd rather operate your own remote MCP, the package ships a Node binary:

```bash
npx -y meridian-orbital meridian-mcp-http
# → listening on http://0.0.0.0:3333/mcp · auth=pass-through · v2.1.0
```

Or via Docker (`MCP_MODE=http` flips the entrypoint):

```bash
docker run --rm -p 3333:3333 -e MCP_MODE=http meridian-orbital
```

Auth modes:

- **Pass-through (default).** Each call's `Authorization: Bearer …` is forwarded to GitHub Models. Users bring their own PAT.
- **Shared gateway.** Set `MERIDIAN_GATEWAY_TOKEN` (what callers pass) + `MERIDIAN_GITHUB_TOKEN` (what the server uses for inference).

The hosted Worker variant additionally implements OAuth 2.1 + PKCE; the Node binary is bearer-only (suitable for stdio→HTTP bridges and tools like `curl`).

## What it does

Single tool: **`route_task(task, limit?)`**.

```
input: a natural-language task
   ↓
GitHub Models (Llama-3.3-70B) generates 5 candidates
   ↓
local orbital classifier
   • derives physics: mass, scope, independence,
     cross_domain, fragmentation, drag, dep_ratio
   • assigns class: planet | moon | trojan |
                    asteroid | comet | irregular
   • computes star-system membership (forge / signal / mind),
     parent candidate, Lagrange potential
   ↓
output: ranked candidates with full bodies, classifications,
        and decision rules
```

Typical call takes **5–15 seconds**. Each result ships its full markdown body so the caller agent can lift the candidate straight into its context window.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `MERIDIAN_GITHUB_TOKEN` | falls back to `GITHUB_TOKEN` | GitHub PAT with `Models: read` scope. Required. |
| `MERIDIAN_MODEL` | `meta/llama-3.3-70b-instruct` | Any [GitHub Models](https://github.com/marketplace/models) chat model |
| `MERIDIAN_MODELS_ENDPOINT` | `https://models.github.ai/inference/chat/completions` | Override for self-hosted gateways |
| `MERIDIAN_CANDIDATES` | `5` | How many candidates the LLM generates per call |
| `MERIDIAN_TIMEOUT_MS` | `90000` | Abort the fetch after this many ms |
| `PORT` | `3333` | (HTTP mode) port for `meridian-mcp-http` |
| `HOST` | `0.0.0.0` | (HTTP mode) bind address |
| `MERIDIAN_HTTP_PATH` | `/mcp` | (HTTP mode) endpoint path |
| `MERIDIAN_GATEWAY_TOKEN` | *(unset)* | (HTTP mode) if set, switches auth from pass-through to shared-key gateway. Bearer must match this value; server uses its own `MERIDIAN_GITHUB_TOKEN` for inference. |

## What changed in `2.0.0`

The `1.x` line called a Cloudflare Worker (`https://ask-meridian.uk/api/orbital-route`) that ran the LLM and orbital classifier server-side. That backend has been retired. `2.0.0`:

- **Self-contained.** The orbital classifier runs in-process. The LLM call goes to GitHub Models directly. No backend dependency.
- **Bring-your-own token.** Free GitHub tier, generous quota.
- **Faster.** 5–15 s instead of 30–50 s (no extra network hop, GitHub's inference is quick).
- **Same output shape.** Drop-in replacement; no agent prompt changes needed.

To keep using the closed-domain Python scorer + curated 88-entry corpus that shipped with `0.3.x`, pin to `meridian-skills-mcp@0.3.2`. To keep calling the now-defunct Cloudflare backend, pin to `1.0.1` (will fail with HTTP 405 on every call).

## Web miniapp + the live remote MCP

Same orbital classifier powers two front-ends served from `mcp.ask-meridian.uk`:

- **[ask-meridian.uk/miniapp](https://ask-meridian.uk/miniapp)** — type a task, see the candidates orbit. Calls the live MCP at `mcp.ask-meridian.uk/v1/route`, same Llama-3.3-70B + classifier path the connector uses.
- **[lens.ask-meridian.uk](https://lens.ask-meridian.uk)** — WebXR Vision Lab, on-device SmolVLM, in-headset orbits. Same backend.

Both call the **first-party browser endpoint** `/v1/route` — Origin-allowlisted, operator-paid, no PAT pasting. The OAuth-gated `/mcp` endpoint (this section's "Use as a Grok connector" path) is unchanged.

## Online learning loop

The browser endpoint `/v1/route` applies a fitted-correction layer on top of the heuristic ranking. Every time a user engages a candidate (planet click in lens, detail-panel open in miniapp, card click in vision-lab), the front-end POSTs to `/v1/feedback` and the worker runs **one pairwise-ranking SGD step** against the chosen candidate vs every other. Constant per-request cost (~1 ms), no GPU, no local execution.

```
user click → /v1/feedback → KV → SGD step → updated weights → next /v1/route uses them
```

- `final_score = heuristic_route_score × (1 + tanh(K · w·x))` — bounded to [0, 2], so no individual candidate can be silently boosted beyond 2× heuristic.
- 24-feature vector per candidate: 8 physics scalars + 6 class one-hot + 3 star-system one-hot + 3 token-hit features + 4 ranking features.
- Cold start: `w = 0`, multiplier = 1, pure heuristic. Day 1 deployments don't need any training data.
- The OAuth-gated `/mcp` path (Grok / ChatGPT / Claude.ai connectors) keeps deterministic heuristic ranking for reproducibility.
- Two GitHub Actions cron jobs close the loop without organic traffic: `classifier-bootstrap.yml` (every 3 days, feeds labelled examples from a public HF benchmark into `/v1/feedback`) and `classifier-health.yml` (Mondays, posts recall@1 / @5 + model state to `landing/healthz.json`).

Read-only model state: `GET https://mcp.ask-meridian.uk/v1/model-info`.

Full architecture + the calibration journey that produced this design (the planet-bias bug, the two textbook physics frameworks we tried and abandoned, the v2 retune, the 81% recall@1 [95% Wilson CI 60%, 92%] finding on real labelled data): [blog post](https://ask-meridian.uk/blog/orbital-classifier-online-learning/).

## License

MIT — see [LICENSE](./LICENSE).
