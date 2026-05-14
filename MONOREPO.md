# Monorepo layout

This was three separate repos before today. They've been merged in so
nav changes propagate from a single source and the project state lives
in one place.

| Subdir | Public surface | Deploy |
|---|---|---|
| `cf-worker/` | `mcp.ask-meridian.uk` | `cd cf-worker && wrangler deploy` |
| `api-worker/` | `api.ask-meridian.uk` | `cd api-worker && wrangler deploy` |
| `finance-mcp/` | `money.ask-meridian.uk` | `cd finance-mcp && wrangler deploy` |
| `pharmacy-mcp/` | `botica.ask-meridian.uk` | `cd pharmacy-mcp && wrangler deploy` |
| `binance-proxy/` | helper (Fly.io, not public) | `cd binance-proxy && fly deploy` |
| `photon-route/` | `photon.ask-meridian.uk` (HF Space) | **see below** |
| `landing/` | `ask-meridian.uk` (GH Pages) | auto on push to `main` |
| `helix/` `lens/` `miniapp/` | `meridian.ask-meridian.uk/*` (CF Pages) | `bash site/build.sh && wrangler pages deploy site/dist --project-name=meridian-shared` |
| `helio-mirror/` | HF Dataset `luuow/meridian-helio-mirror` | workflow_dispatch in `.github/workflows/` |
| `scripts/sync-nav.py` | — | run before landing deploy to DRY the nav across pages |

## photon-route — automated mirror

`photon-route/` is the canonical source. On every push to `main` that
touches `photon-route/**`, `.github/workflows/sync-photon-route.yml`
runs `git subtree split` and force-pushes the result to
`LuuOW/photon-route` main. The HF Space at
`huggingface.co/spaces/luuow/photon-route` continues syncing from
that standalone repo unchanged — it's now a derived artifact and
nobody edits it directly.

Required secret: `PHOTON_SYNC_PAT` (GH PAT with push access to
`LuuOW/photon-route`).

## Archived standalone repos

Now living entirely in this monorepo (archived on GitHub):
- `LuuOW/lens` → `meridian-mcp/lens/`
- `LuuOW/binance-proxy` → `meridian-mcp/binance-proxy/`
- `LuuOW/finance-mcp` → `meridian-mcp/finance-mcp/`
- `LuuOW/pharmacy-mcp` → `meridian-mcp/pharmacy-mcp/`

`LuuOW/photon-route` stays unarchived because the HF Space pulls
from it, but the workflow above keeps it auto-synced from the
monorepo subdir.
