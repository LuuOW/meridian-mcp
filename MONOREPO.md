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

## photon-route caveat

The Hugging Face Space at `huggingface.co/spaces/luuow/photon-route` is
linked to `github.com/LuuOW/photon-route` for git-based sync. HF Spaces
don't natively sync from a *subdirectory* of a different repo, so until
that integration is reworked the photon-route content here is a copy
maintained in-tree for nav consistency. Deploys still need to happen
from the standalone `LuuOW/photon-route` repo. Options to revisit:

1. Add a GH Action in this repo that pushes `photon-route/` to a sync
   branch on the standalone repo when it changes.
2. Restructure the HF Space to use Spaces-native git sync from its
   own HF-side repo and treat this monorepo subdir as the canonical
   source via a deploy script.

## Archived standalone repos

Now living entirely in this monorepo (archived on GitHub):
- `LuuOW/lens` → `meridian-mcp/lens/`
- `LuuOW/binance-proxy` → `meridian-mcp/binance-proxy/`
- `LuuOW/finance-mcp` → `meridian-mcp/finance-mcp/`
- `LuuOW/pharmacy-mcp` → `meridian-mcp/pharmacy-mcp/`

`LuuOW/photon-route` stays unarchived until the HF Space sync is
reworked.
