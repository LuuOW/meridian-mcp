# helio-mirror

Multi-spacecraft solar irradiance triangulator.

PSP measures the Sun's emissive state *directly* (B-field, plasma, energetic
particles, eventually coronagraph). JWST observes the Sun *indirectly* through
sunlight scattered off solar-system bodies (Mars, Jupiter, Saturn, moons,
asteroids, comets). By cross-correlating PSP solar-event signatures with JWST
reflectance excursions on bodies at known heliographic positions, we measure
**irradiance delivered to each body** and forecast it 24 h ahead.

## Stages

| # | Stage | Reads | Writes |
|---|---|---|---|
| 1 | **pull** | NASA / STScI public archives | `psp/`, `jwst/`, `ephemeris/` on HF |
| 2 | register | stage 1 | `coords/registered.parquet` |
| 3 | detect | stage 2 + raw | `events/{psp,jwst}_events.parquet` |
| 4 | coincide | stage 3 | `events/coincidences.parquet` |
| 5 | calibrate | stage 4 + raw spectra | `irradiance/delivered.parquet` |
| 6 | forecast | stages 2 + 3 + 5 | `forecast/irradiance_24h.parquet` |

Only stage 1 is scaffolded today. Stages 2–6 land after stage 1 has produced
real data on the HF dataset `luuow/meridian-helio-mirror`.

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
