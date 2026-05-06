# Meridian Skills MCP

**Dynamic AI skill routing via orbital mechanics.**

Self-contained stdio MCP. Generates candidate skills with Llama-3.3-70B (via [GitHub Models](https://github.com/marketplace/models)) and ranks them with a local orbital classifier into celestial classes (`planet`, `moon`, `trojan`, `asteroid`, `comet`, `irregular`).

[![npm](https://img.shields.io/npm/v/meridian-skills-mcp.svg)](https://www.npmjs.com/package/meridian-skills-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Install

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
