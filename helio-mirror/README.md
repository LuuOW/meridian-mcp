# helio-mirror

Multi-spacecraft solar irradiance triangulator.

PSP measures the Sun's emissive state *directly* (B-field, plasma, energetic
particles, eventually coronagraph). JWST observes the Sun *indirectly* through
sunlight scattered off solar-system bodies (Mars, Jupiter, Saturn, moons,
asteroids, comets). By cross-correlating PSP solar-event signatures with JWST
reflectance excursions on bodies at known heliographic positions, we measure
**irradiance delivered to each body** and forecast it 24 h ahead.

## Stages — all six scaffolded

| # | Stage | Script | Workflow | Writes to HF |
|---|---|---|---|---|
| 1 | **pull** | `pull.py` | `helio-mirror-pull` | `psp/`, `jwst/`, `ephemeris/` |
| 2 | **register** | `register.py` | `helio-mirror-register` | `coords/ephemeris_long_*`, `coords/psp_registered_*`, `coords/jwst_registered_*` |
| 3 | **detect** | `detect.py` | `helio-mirror-detect` | `events/psp_pvi_*`, `events/psp_candidate_events_*`, `events/jwst_aggregates_*` |
| 4 | **coincide** | `coincide.py` | `helio-mirror-coincide` | `events/coincidences_*`, `events/coincidences_summary_*.json` |
| 5 | **calibrate** | `calibrate.py` | `helio-mirror-calibrate` | `irradiance/delivered_*` |
| 6 | **forecast** | `forecast.py` | `helio-mirror-forecast` | `forecast/forecast_24h_*`, `forecast/latest.json` |

Each workflow is `workflow_dispatch` only and takes a `perihelion` input
(`E20`–`E24`). Stages are independently rerunnable; `latest.json` is the
artifact the dashboard at `/helio/` reads.

## Live dashboard

`https://ask-meridian.uk/helio/` — loads `forecast/latest.json` from the HF
dataset on each pageview, renders per-body cards + 24 h tables + caveats.

## Stage 1 — pull (current scope)

For one perihelion window:

- **PSP**: FIELDS L2 `mag_rtn_4_per_cycle` (B-field) + SWEAP/SPC L3 ion
  moments (v, n). ISOIS and WISPR deferred.
- **JWST**: `obs_collection=JWST`, `target_name ∈ {Mars, Jupiter, Saturn}` at
  `calib_level=3`. Capped at 2 observations per body.
- **Ephemeris**: JPL Horizons heliocentric vectors at 1 h cadence for PSP,
  Earth, and each JWST target body.

All artifacts land on `luuow/meridian-helio-mirror` (created on first push).

## Triggering

```bash
# via GitHub Actions UI: Actions → helio-mirror-pull → Run workflow → pick perihelion
# or via gh CLI:
gh workflow run helio-mirror-pull.yml -R LuuOW/meridian-mcp -f perihelion=E20
```

## Required GitHub secret

`HF_TOKEN` — write-scoped HF access token. Set under
Settings → Secrets and variables → Actions.

## What's NOT in stage 1

- WISPR coronagraph imagery (needed for true 3D CME direction)
- ISOIS energetic-particle data (SEP onset detection)
- Per-body reflectance calibration (lives in stage 5)
- Forecasting model (lives in stage 6)
