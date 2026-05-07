# Meridian Skills MCP

**Dynamic AI skill routing via orbital mechanics.**

Self-contained MCP — stdio for local hosts (Claude Code, Cursor, Windsurf…) and Streamable HTTP for remote connectors (Grok, ChatGPT custom MCP, anything that takes a server URL). Generates candidate skills with Llama-3.3-70B (via [GitHub Models](https://github.com/marketplace/models)) and ranks them with a local orbital classifier into celestial classes (`planet`, `moon`, `trojan`, `asteroid`, `comet`, `irregular`).

[![npm](https://img.shields.io/npm/v/meridian-skills-mcp.svg)](https://www.npmjs.com/package/meridian-skills-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Install (stdio — Claude Code / Cursor / Windsurf)

```bash
npm install -g meridian-skills-mcp
claude mcp add meridian meridian-mcp
```

Same install works in Cursor, Windsurf, Goose, Continue, and any MCP client that speaks stdio.

You'll need a GitHub personal access token with the `Models: read` permission (free tier). Generate one at https://github.com/settings/personal-access-tokens/new and export it:

```bash
export MERIDIAN_GITHUB_TOKEN=github_pat_...
```

(The MCP also picks up plain `GITHUB_TOKEN` if you have one already in your environment.)

## Use as a Grok connector (or ChatGPT custom MCP)

Grok connectors (`docs.x.ai/grok/connectors`) and the ChatGPT MCP integration both ask for an **MCP server URL** + a bearer token — they can't spawn a stdio process. Run the HTTP variant for that:

```bash
# anywhere Node 20+ runs (Fly, Render, Docker, your own VPS)
npx -y meridian-skills-mcp meridian-mcp-http
# → listening on http://0.0.0.0:3333/mcp · auth=pass-through · v2.0.0
```

Or via Docker:

```bash
docker run --rm -p 3333:3333 -e MCP_MODE=http \
  ghcr.io/luuow/meridian-skills-mcp:latest
```

Then point Grok/ChatGPT at:

| Field | Value |
|---|---|
| Server URL | `https://your-host.example.com/mcp` |
| Authorization | `Bearer github_pat_…` *(your `Models: read` PAT)* |

**Auth model — pass-through (default).** The bearer token in the `Authorization` header *is* the user's GitHub PAT. The server passes it straight through to GitHub Models for that user's call. No shared inference cost, no user database, no credentials at rest on the server. Each user configures the connector with their own PAT.

**Auth model — shared gateway (optional).** If you'd rather operate it as a service with one fixed key, set both:

```bash
MERIDIAN_GATEWAY_TOKEN=secret-shared-token   # what users pass as the bearer
MERIDIAN_GITHUB_TOKEN=github_pat_…           # what the server uses for inference
```

In this mode the operator pays the inference and rotates the gateway token.

The HTTP transport is **stateless** (`sessionIdGenerator: undefined`) and uses the SDK's `StreamableHTTPServerTransport` — fully compliant with the MCP Streamable HTTP spec, including SSE upgrade for streamed responses if a client requests it.

## What it does

Single tool: **`route_task(task, limit?)`**.

```
input: a natural-language task
   ↓
GitHub Models (Llama-3.3-70B) generates 5 candidate skills
   ↓
local orbital classifier
   • derives physics: mass, scope, independence,
     cross_domain, fragmentation, drag, dep_ratio
   • assigns class: planet | moon | trojan |
                    asteroid | comet | irregular
   • computes star-system membership (forge / signal / mind),
     parent skill, Lagrange potential
   ↓
output: ranked skills with full bodies, classifications,
        and decision rules
```

Typical call takes **5–15 seconds**. Each result ships its full markdown body so the caller agent can lift the skill straight into its context window.

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

To keep using the closed-domain Python scorer + curated 88-skill corpus that shipped with `0.3.x`, pin to `meridian-skills-mcp@0.3.2`. To keep calling the now-defunct Cloudflare backend, pin to `1.0.1` (will fail with HTTP 405 on every call).

## Web miniapp

Same orbital classifier (in pure JS, runs in your browser) powers [ask-meridian.uk/miniapp](https://ask-meridian.uk/miniapp) — type a task, see the candidates orbit. The web demo uses a static 88-skill corpus instead of LLM generation; it's complementary to this MCP, not the same code path.

## License

MIT — see [LICENSE](./LICENSE).
