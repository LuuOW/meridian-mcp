# helio-mirror roadmap

Tracking what we know is missing in v0.1, in priority order. Each item lists
the gap, the fix, and the **output impact** — i.e., what the final forecast
gets to claim once the item lands.

## Status legend

- ☐ — not started
- ⟳ — scaffolded, awaiting data / verification
- ✓ — done and verified

## v0.3 — HSO mode (in flight)

### 0. Heliophysics System Observatory ingest — ✓ structurally working

PSP × JWST-reflection alone has zero coincidences because of how
infrequently JWST images a body at the right heliographic position vs
PSP's encounter. Real triangulation uses NASA/ESA's existing fleet —
SolO, STEREO-A, Wind, ACE, DSCOVR, MAVEN — pulled from CDAWeb via
pyspedas, all time-overlapping every PSP perihelion.

- **Status:** `probes.py` + multi-probe register / detect / coincide
  shipped. E20 end-to-end run confirms 5/6 probes load (MAVEN was the
  only one with no CDAWeb data for that window — not a code issue).
- **Loose-tolerance honesty:** initial run on ±20°/±24h showed 979
  matched coincidences, BUT null_test.py (100 shuffles of timestamps
  within each spacecraft) shows the null mean is 985 with z=-3.0,
  p=1.0 — i.e., **the loose-tolerance "979 matches" is indistinguishable
  from chance.** With 1500+ events at that tolerance, virtually any
  pairing matches.

### 0a. Physics-aware tolerances (stage-4-tight) — ⟳ tighter but still null-saturated on E20

Replaces constant ±20°/±24h with per-pair-type bands scaled by
predicted Parker transit (`coincide_tight.py`). E20 result: **212
matched / 265 candidate pairs, median match score 0.781** (vs 0.29
loose). The big improvement comes from L1↔L1 pairs (transit ~0) getting
±5°/0.5h, and STEREO-A↔L1 getting ±10°/2h — both are properly
discriminated now.

**Null result on E20 (tight mode):** observed=212, null_mean=226.7,
z=-5.88, p=1.0 — still indistinguishable from null. PVI > 3 threshold
admits ~1500 events per perihelion across 5 probes; that's dense enough
that even tight tolerances saturate. Match-count alone won't separate
signal from chance at this event density.

### 0b. Reduce PVI noise floor — ✓ rare-event detection is the path forward

The honest implication of the null results: we need fewer, rarer events
to escape the saturation, OR a correlation metric that goes beyond
"any event within tolerance" (e.g., amplitude correlation, peak-to-peak
matching).

- **Concrete next step:** raise PVI threshold to 5 (from 3) and re-run.
  This drops the event count by ~10× per spacecraft; null saturation
  should drop with it. Then re-test.
- **Alternative:** integrate WISPR (CME-front catalogue, not pyspedas)
  for rare events that DO advect predictably.

### 0c. Null test panel across all 5 perihelia — ✓ E21 is the only significant signal

100-shuffle loose-mode null tests on all 5 perihelia:

| Perihelion | observed | null mean | z | verdict |
|---|---|---|---|---|
| E20 | 979 | 985 | -3.0 | indistinguishable |
| **E21** | **338** | **288** | **+4.98** | **SIGNIFICANT** |
| E22 | 825 | 867 | -5.2 | indistinguishable |
| E23 | 743 | 915 | -14.6 | indistinguishable |
| E24 | 239 | 249 | -4.1 | indistinguishable |

**E21 is the only perihelion where observed > null at p < 0.001.** Its
pair breakdown (DSCOVR→ACE 206, PSP→DSCOVR 71, PSP→ACE 61) includes
real PSP→outer-probe matches — produced by Parker-spiral advection from
PSP perihelion to L1 monitors with the geometry happening to align.

**Why 4 of 5 perihelia show z < 0:** likely the v_sw=400 km/s constant
disagrees with real solar wind speed at those perihelia, so the spiral
lon prediction misses real coincidences. Timestamp-shuffled events
don't fight the spiral — they just need to satisfy the lon-tol
geometrically — so the null catches MORE matches than the physics-aware
model does on those perihelia.

- **Defensible claim:** "at E21 geometry, probe-pair coincidences at
  ±20°/±24h occur 17% more often than chance (p < 0.001, n=100)."

### 0d. v_sw integration shipped — marginal impact on E20

The v_sw fix landed (`plasma.py` + per-event v_sw in `coincide.py`).
On E20:
- Plasma loaded for PSP (median **240 km/s** at deep perihelion!),
  STEREO-A (388), Wind (432), ACE (455). SolO + DSCOVR empty in this
  CDAWeb window.
- 1018/1529 events (67%) got per-event v_sw; rest use 400 constant.
- **Coincidence count barely changed: 979 → 979 matched (different
  candidate pool because PSP transits are now longer), score 0.29 → 0.31.**

**Why so little impact:** L1↔L1 + STEREO-A↔L1 still dominate the
matched pool — short transits where v_sw barely matters. PSP→outer
pairs (which the v_sw correction was supposed to rescue) actually get
WORSE because PSP at perihelion has slow wind (240 km/s vs assumed
400), making the spiral wrap MORE not less, pushing predictions further
past the lon-tolerance.

### 0e. v_sw(r) averaging shipped — moves the needle on E24

Implemented source+target plasma speed averaging in
`find_probe_coincidences` (load_all_plasma + target_vsw_at + linear
average of v_src and v_tgt as the spiral advection speed).

**Null test panel comparison (constant 400 km/s vs v_sw averaged):**

| Perihelion | v=400 | v_sw avg | Result |
|---|---|---|---|
| E20 | z=-3.0 indist | z=0.0 indist | fully saturated; tolerance band catches all density |
| **E21** | **z=+4.98 SIG** | **z=+4.24 SIG** | claim survives the model upgrade |
| E22 | z=-5.2 | z=-3.4 | improved by ~1.8σ |
| E23 | z=-14.6 | z=-15.5 | marginally worse |
| **E24** | **z=-4.1** | **z=+2.36 MARGINAL** | **swung from indistinguishable to p<0.05** |

**Pipeline now produces 1 strong + 1 marginal claim** (was 1 strong).

Defensible statement: "At E21 geometry, probe-pair coincidences at
±20°/±24h tolerance occur 13% more often than chance (z=+4.2,
p<0.001, n=100 shuffles, source+target v_sw averaging). At E24 the
same test gives z=+2.4 (p≈0.02), marginal evidence."

### 0b. Inner-heliosphere → outer-probe Parker transit exceeds perihelion window

A 4-day perihelion window catches ACE↔DSCOVR (co-located at L1) and
STEREO-A↔L1 monitors (sub-day transit), but PSP→SolO would need ~20 d
at 400 km/s — so PSP-sourced events never appear in the coincidence
list within a single perihelion. That's why the per-pair list only
shows ACE/DSCOVR/STEREO-A, never PSP or SolO as source.

- **Output impact:** the current "979 matches" is real but lopsided —
  all matches are short-baseline. Long-baseline coincidences need a
  wider window.
- **Fix:** extend `PERIHELIA[X]` windows to ±14 d around perihelion, OR
  introduce a separate "cross-perihelion" window for long-baseline pairs.

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

### 10. Honest error gates — ⟳ retry policy done; per-stage gate JSON TBD

(Status: `hf_push.push_folder` + per-stage folder commits keeps the
five-perihelion fanout under HF's 128 commits/hour. Per-stage gate JSON —
"N inputs / N outputs / pass-fail" — still TBD.)



- **Gap:** Stage 4 v0.1 silently returned 0 coincidences with no warning.
- **Fix:** explicit gate JSON per stage (`gate.json` per stage output)
  recording N inputs / N outputs / pass/fail thresholds. Dashboard reads
  the gate file and shows pass/fail pills.
- **Output impact:** failure modes become visible without log-diving.
