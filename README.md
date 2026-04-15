# Meridian MCP

**Calibrated AI skill routing via orbital mechanics.**
An MCP server that picks the right expertise for every AI query. Deterministic scoring. 73 curated skills (hosted) or bring your own.

[![npm](https://img.shields.io/npm/v/meridian-skills-mcp.svg)](https://www.npmjs.com/package/meridian-skills-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Install

### Hosted (paid) — 30 seconds

Get an API key at [ask-meridian.uk](https://ask-meridian.uk), then:

```bash
claude mcp add meridian https://ask-meridian.uk/api/mcp \
  --transport http \
  -H "Authorization: Bearer mrd_live_YOUR_KEY"
```

Works with Claude Code, Cursor, Windsurf, or any MCP client.

### Self-hosted (free, OSS)

```bash
npm install -g meridian-skills-mcp
claude mcp add meridian meridian-mcp
```

Point at your own skill corpus:

```bash
MERIDIAN_SKILLS_ROOT=/path/to/your/skills meridian-mcp
```

See [`example-skills/`](./example-skills) for the SKILL.md format.

## What it does

Given a task description, returns the most relevant skills from a curated corpus — ranked by a deterministic physics-inspired scoring function (Roche limits, Lagrange points, Hill spheres). Each skill ships with `route_score`, `class`, and a `why` explanation.

### Four MCP tools

| Tool | Purpose |
|---|---|
| `route_task(task, limit)` | Rank skills by relevance to a task |
| `get_skill(slug)` | Fetch full SKILL.md content |
| `list_skills()` | Enumerate all available skills |
| `search_skills(query)` | Full-text search with snippets |

### Resources

Every skill is also exposed as an MCP resource: `meridian://skills/<slug>`.

## Authoring skills

A skill is just a directory with a `SKILL.md` file:

```markdown
---
name: your-skill-name
description: One-line description used by the router to score relevance.
---

# your-skill-name

Body content — instructions, patterns, examples. Kept under 2000 words for best routing.
```

Place under `MERIDIAN_SKILLS_ROOT` and the server picks it up on next request.

## Architecture

```
                         ┌─── stdio transport (local install)
MCP client ──► meridian-mcp
                         └─── HTTP Streamable transport (hosted)

                         ┌─── skill_orbit.py (Python routing engine)
meridian-mcp ───► /opt/skills/
                         └─── 73+ SKILL.md files
```

The routing math is documented in [the ArXiv paper](https://arxiv.org/abs/TBD) (pre-print).

## Pricing (hosted)

| Plan | Price | Quota |
|---|---|---|
| Free | $0 | self-hosted OSS |
| Pro | $29/mo | 10K tool calls/mo |
| Team | $149/mo | 100K calls/mo, 5 keys |

## Contributing

PRs welcome for new `example-skills/*`, bug fixes, and transport improvements. For changes to the orbital-routing engine itself, please open an issue first.

## License

MIT — see [LICENSE](./LICENSE).

---

Built in Buenos Aires. Run by World-ID-verified humans.
