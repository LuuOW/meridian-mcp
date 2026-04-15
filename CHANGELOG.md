# Changelog

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
