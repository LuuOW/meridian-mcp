# meridian-stellar

Cloud-only data pipeline for the meridian harvest-forecast project.

Pulls public NASA / STScI archives, lands them in a public HF Dataset.
No local disk involvement.

## Pipeline

```
GitHub Actions (workflow_dispatch + weekly cron)
   ├── pyspedas        → PSP CDF, downsampled to Parquet
   ├── astroquery.mast → JWST x1d calibrated spectra
   └── huggingface_hub → push to LuuOW/meridian-stellar-cache
```

## First-pull scope

Deliberately tiny for path-validation:

- **PSP**: 1 day of FIELDS `mag_rtn_4_per_cycle` (~4 MB)
- **JWST**: capped TRAPPIST-1 `x1d` slice (~tens of MB)

Once the HF push works end-to-end, expand windows and target list.

## Triggering

```bash
gh workflow run stellar-pull.yml -R LuuOW/meridian-mcp
```

Or via the GitHub Actions tab → `stellar-pull` → "Run workflow".

## Required GitHub secret

- `HF_TOKEN` — write-scoped HF access token. Set under
  Settings → Secrets and variables → Actions.
