# helio-mirror roadmap

Tracking what we know is missing in v0.1, in priority order. Each item lists
the gap, the fix, and the **output impact** — i.e., what the final forecast
gets to claim once the item lands.

## Status legend

- ☐ — not started
- ⟳ — scaffolded, awaiting data / verification
- ✓ — done and verified

## v0.2 — bigger and more honest

### 1. Multi-perihelion run (E21–E24) — ⟳ in progress

(Status: `helio-mirror-fanout` running serially with `max-parallel: 1` to
avoid the HF Hub 429s the first parallel attempt hit.)


- **Gap:** Only E20 has been processed end-to-end. Data for the four other
  perihelia is on HF (raw) but never registered, detected, or forecast.
- **Fix:** Loop `helio-mirror-all` over `{E21, E22, E23, E24}` (manual
  dispatch x4 or a fan-out workflow that calls each via `workflow_call`).
- **Output impact:** five times the events × five times the body
  observations × five times the coincidences. Statistical floor goes from
  "first run, n=1" to "preliminary, n=5". Critical for any
  honest skill claim.

### 2. Coincidences-now-non-zero verification — ⟳ depends on item 1


- **Gap:** v0.1 returned 0 coincidences because the JWST query wasn't
  time-windowed. The fix is shipped (`pull.py` ±90 d window) but unverified.
- **Fix:** rerun the chain on E20 with the patched puller. Confirm the new
  JWST FITS are near 2024-06 and that stage 4 emits >0 coincidences.
- **Output impact:** flips the dashboard from "structurally correct, no
  matches yet" to "first real cross-body event chain".

### 3. WISPR coronagraph integration — ⟳ scaffolded


- **Gap:** PSP B-field only tells us **a** CME happened, not where it's
  going. Without WISPR we can only assume radial propagation from PSP's
  current location.
- **Fix:** add `pyspedas.psp.wispr()` to `pull.py`, write a stage 3b
  (`detect_wispr.py`) that runs simple brightness-front detection on
  L3 difference images, emits `events/wispr_cme_fronts_{PERIHELION}.parquet`
  with (lon, lat, v) of detected fronts.
- **Output impact:** stage 4 can replace radial-only assumption with
  measured CME direction → tighter lon tolerance → fewer false
  coincidences.

### 4. ISOIS energetic particles — ⟳ scaffolded


- **Gap:** SEP onsets show up cleanly in particle data; PVI is a proxy.
- **Fix:** `pyspedas.psp.epihi()` L2 integrated count rates, threshold-cross
  detector → `events/psp_sep_onsets_{PERIHELION}.parquet`.
- **Output impact:** "PSP detected X" splits into "X was a current sheet"
  vs "X was a flare/SEP", improving downstream interpretation.

### 5. Absolute irradiance calibration

- **Gap:** current `inferred_irradiance_proxy` is comparable within
  (body, filter) but not in W/m².
- **Fix:** for each NIRCam / MIRI filter, integrate solar SED through the
  filter bandpass (use astropy / `synphot`) to get a zero-point. Apply at
  the end of stage 5.
- **Output impact:** the forecast becomes "X W/m² at body Y in next 24 h",
  which is what the resume bullet promises.

## v0.3 — predictive skill

### 6. ML residual layer — ⟳ scaffolded


- **Gap:** Forecast is persistence × r² — beats nothing once we have a real
  evaluation set.
- **Fix:** once items 1–5 give us N≥30 (body, filter, t) anchors per body,
  train a per-body Ridge / small MLP that predicts log10(I_t+24h) from
  (current_PSP_features, current_phase_angle, days_since_last_obs). Score
  vs persistence baseline.
- **Output impact:** the project earns a real skill claim ("beats persistence
  by N% MAE"). Without this, all we have is honest geometry.

### 7. Multi-body diurnal sampling

- **Gap:** JWST only observes a body briefly; we can't see its diurnal
  variability.
- **Fix:** pull MIRI/NIRCam observations spanning multiple visits per body;
  for Jupiter especially, intra-visit time-series exist.
- **Output impact:** body-rotation effects can be modelled instead of
  smeared into the proxy.

## v0.4 — operational

### 8. Cron orchestrator — ✓ done


- **Gap:** Everything is manual `workflow_dispatch`.
- **Fix:** Add weekly cron in `helio-mirror-all.yml` that picks the most
  recent perihelion in `targets.PERIHELIA` and runs.
- **Output impact:** dashboard becomes truly live (last-updated timestamp
  is meaningful).

### 9. Sub-domain + Worker

- **Gap:** Dashboard lives at `ask-meridian.uk/helio/`. Sister projects
  have subdomains.
- **Fix:** Cloudflare Worker proxy `helio.ask-meridian.uk/* → ask-meridian.uk/helio/*`,
  same pattern as the (removed) stellar one. With the bugfix already in
  `cf-worker/stellar-proxy.mjs` carried over.
- **Output impact:** cosmetic — branded subdomain like the others.

### 10. Honest error gates — ⟳ partial (HF 429 retry done, per-stage gates TBD)


- **Gap:** Stage 4 v0.1 silently returned 0 coincidences with no warning.
- **Fix:** explicit gate JSON per stage (`gate.json` per stage output)
  recording N inputs / N outputs / pass/fail thresholds. Dashboard reads
  the gate file and shows pass/fail pills.
- **Output impact:** failure modes become visible without log-diving.
