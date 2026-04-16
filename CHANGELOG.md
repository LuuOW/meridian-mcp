# Changelog

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
