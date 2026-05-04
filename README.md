# Meridian Skills MCP

> 📘 **Want to ship your own MCP server like this one?**
> [Build Your Own MCP Server With Auth + Billing — In 30 Minutes](https://kempefire.gumroad.com/l/build-your-own-mcp) ($29)
> Same exact stack: Cloudflare Workers + KV + Stripe webhook + AI Gateway. Working code + 60-page guide.

**Dynamic AI skill routing via orbital mechanics.**

Stdio MCP that calls the Meridian orbital router at [ask-meridian.uk](https://ask-meridian.uk).
Skills are generated on-demand by Llama-3.3-70B and classified by an open-domain orbital engine into celestial classes (`planet`, `moon`, `trojan`, `asteroid`, `comet`, `irregular`).

[![npm](https://img.shields.io/npm/v/meridian-skills-mcp.svg)](https://www.npmjs.com/package/meridian-skills-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Install

```bash
npm install -g meridian-skills-mcp
claude mcp add meridian meridian-mcp
```

Same install works in Cursor, Windsurf, and any MCP client that speaks stdio.

## What it does

Single tool: **`route_task(task, limit?)`**.

```
input: a natural-language task
   ↓
Workers AI (Llama-3.3-70B) generates 5 candidate skills
   ↓
open-domain orbital classifier
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

Each call takes 30–50 s (the LLM does the work). Each result ships its full markdown body so the caller agent can lift the skill straight into its context window.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `MERIDIAN_API_URL`   | `https://ask-meridian.uk/api/orbital-route` | Override the backend (e.g. for a self-hosted Pages clone) |
| `MERIDIAN_API_KEY`   | _(none)_ | Optional bearer token for future rate-limit gating |
| `MERIDIAN_TIMEOUT_MS`| `90000`  | Abort the fetch after this many ms |

## How it differs from `0.3.x`

The `0.3.x` line shipped a closed-domain Python orbital scorer plus a curated 88-skill corpus, all running locally. `1.0.0` flips that:

- No local model. No Python. No bundled SKILL.md files.
- Single dependency: `@modelcontextprotocol/sdk`.
- Internet required — every call hits the public router.
- Skills are different on every call (LLM-generated for *your* task).

To keep using the offline corpus path, pin to `meridian-skills-mcp@0.3.2`.

## Web miniapp

Same backend powers [ask-meridian.uk/miniapp](https://ask-meridian.uk/miniapp) — a browser-based demo with 2D/3D orbital visualisation and AR object-detection. Identical routing pipeline, two interfaces.

## License

MIT — see [LICENSE](./LICENSE).
