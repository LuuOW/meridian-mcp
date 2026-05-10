# meridian-stellar

Cloud-only data pipeline for the meridian harvest-forecast project.

Pulls public NASA / STScI archives, lands them in a public HF Dataset.
No local disk involvement.

## Pipeline

```
GitHub Actions (workflow_dispatch + weekly cron)
   ├── pyspedas        → PSP CDF, downsampled to Parquet
   ├── astroquery.mast → JWST x1d calibrated spectra
   ├── astroquery.jpl  → PSP/Earth ephemeris (Parker-spiral connection)
   └── huggingface_hub → push to luuow/meridian-stellar-cache
```

## Stages

| # | Workflow | Script | Output to HF dataset |
|---|---|---|---|
| 1 | `stellar-pull` | `pull.py` | `psp/`, `jwst/` raw |
| 2 | `stellar-features` | `features_psp.py`, `features_jwst.py` | `features/` |
| 3 | `stellar-archetypes` | `archetypes.py` | `archetypes/` |
| 4 | `stellar-harvester` | `harvester.py` | `harvest/E_truth.parquet` |
| 4B | `stellar-parker` | `parker_connection.py` | `parker/connection.parquet`, `parker/status.json` |
| 5+6 | `stellar-train-eval` | `train_eval.py` | `specialists/`, `evaluation/results.json` |
| 7 | `stellar-project-jwst` | `project_jwst.py` | `jwst/projection.parquet`, `evaluation/gate_3.json` |
| 8 | `stellar-forecast-l1` | `forecast_l1.py` | `parker/forecast_l1.parquet`, `parker/forecast_l1_latest.json` |

Stage 4B + 8 are the **HelioCast** layer: Earth-PSP Parker-spiral connection
geometry + advected forecast at L1. Forecast is silent outside connection
windows (no fabricated outputs).

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
