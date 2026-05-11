# helio-mirror runbook

Operator-side cheatsheet for running and debugging the pipeline.

## Routine operations

### Refresh a single perihelion (the one-click path)

```bash
gh workflow run helio-mirror-all.yml \
  -R LuuOW/meridian-mcp \
  -f perihelion=E20
```

Wall clock: ~10–15 min (5 of which is pip install on cold cache).
Reads / writes: `luuow/meridian-helio-mirror` on HF.

### Refresh all five perihelia (serial fanout)

```bash
gh workflow run helio-mirror-fanout.yml -R LuuOW/meridian-mcp
```

Wall clock: ~75 min (`max-parallel: 1` because HF Hub commit API 429s under
parallel uploads to the same dataset).

Use this after a stage-level patch (e.g., a feature change in `detect.py`).

### Train the ML residual layer

```bash
gh workflow run helio-mirror-ml-residual.yml -R LuuOW/meridian-mcp
```

Reads every `irradiance/delivered_*.parquet`, builds (anchor, future) pairs,
fits per-body Ridge with a **chronological 80/20 holdout** (oldest train,
newest test). A specialist only ships if `(baseline_test_mae − model_test_mae)
/ baseline_test_mae > 0` on the held-out set — i.e., it has to beat
persistence-r². Bodies that fail this skill gate go to
`insufficient_data_bodies` with the reason `"Ridge worse than persistence"`,
and `forecast.py` falls back to persistence-only for them.

With our current cadence (≈1 JWST obs per body per perihelion), this WILL
gate until items 1–2 of `ROADMAP.md` give us more data per body. **Now
also runs automatically at end of `helio-mirror-fanout.yml` (post-matrix job).**

### Refresh just the dataset health summary

```bash
gh workflow run helio-mirror-status.yml -R LuuOW/meridian-mcp
```

Reads the file tree on HF, emits `forecast/dataset_status.json` for the
dashboard's pipeline-state panel. Also gathers per-stage `gates/*.json`
into `gates_per_perihelion` so the dashboard can render pass/fail pills
without log diving. Fast (no compute).

### Generate the portfolio findings markdown

```bash
gh workflow run helio-mirror-findings.yml -R LuuOW/meridian-mcp
```

Reads `latest_{P}.json` + `dataset_status.json` + per-stage gates +
coincidence summaries; emits `findings/FINDINGS.md` (canonical) plus
per-perihelion `FINDINGS_{P}.md`. Suitable for pasting into a portfolio
page or resume bullet. Also runs at end of fanout.

### Compute filter zeropoints (one-shot)

```bash
gh workflow run helio-mirror-zeropoints.yml -R LuuOW/meridian-mcp
```

Computes Planck-tophat zeropoints for 36 NIRCam/MIRI filters and pushes
`forecast/filter_zeropoints.json`. Once present, `calibrate.py` emits
`expected_in_band_W_m2_at_body` per JWST observation and `forecast.py`
forwards it into `latest.json` — the dashboard body card then renders
"in-band W/m² · zp-calibrated". Run once after pipeline bootstrap.

### Weekly auto-refresh

`helio-mirror-all.yml` has a `cron: "0 6 * * 1"` (Mondays 06:00 UTC) that
refreshes the most recent perihelion (default E24). No manual intervention.

## Diagnostics

### Pipeline state at a glance

```bash
curl -s https://huggingface.co/datasets/luuow/meridian-helio-mirror/resolve/main/forecast/dataset_status.json | jq
```

The dashboard renders the same JSON.

### Pull failed — which stage / why?

```bash
gh run list --workflow=helio-mirror-pull.yml -L 3
gh run view <run-id> --log-failed
```

Common failure modes seen so far:

| Symptom | Cause | Fix |
|---|---|---|
| `module 'numpy' has no attribute 'in1d'` | `astropy<7.1` pinned with `numpy>=2` | Drop the astropy pin; pyspedas pulls compatible version transitively. |
| `KeyError: 'perihelion'` in stage-2 | `archetypes/labels.parquet`-style file missing the perihelion column | Make sure stage-1 (harvester/E_truth) ran first; merge perihelion column from there. |
| `cannot convert float NaN to integer` in stage-4 | PSP samples outside the 1-h ephemeris merge_asof tolerance carry NaN r_au; one of `r_psp` / `r_body` was NaN | `coincide.py` now does `np.isfinite(r_psp) and np.isfinite(r_body)` defensively. Re-run. |
| `429 Too Many Requests` on HF commit | HF free tier caps at 128 commits/hour per repo. Many small `upload_file` calls in a tight loop blow the budget within one perihelion. | Two-prong: all stages now call `hf_push.push_folder` to batch a stage's outputs into a single commit; `hf_push.push` retries 429/5xx with exponential backoff (2/5/15/45/120s). Fanout serialised with `max-parallel: 1`. |
| `No links matching pattern psp_swp_spc_l3i_*` | PSP SWEAP/SPC L3 is gappy post-E18 | Use SWEAP/SPAN-I (`psp.spi`) — that's what `pull.py` does now. |
| JWST anchor is years off PSP perihelion | MAST query unwindowed | `search_jwst()` now takes `t_start/t_stop` and a `window_days=365` band; falls back to nearest-in-time if window is empty. |
| `module 'pyspedas.projects.psp' has no attribute 'wispr'` | pyspedas ships fields/spc/spe/spi/epihi/epilo/rfs only — no wispr loader. | `pull.py` short-circuits with `hasattr` check; stage 3b gates on missing input. Direct PSP SOC HTTP fetch is a v0.4 item. |
| `mag() got an unexpected keyword argument 'level'/'datatype'/'time_clip'` (STEREO-A / DSCOVR / MAVEN / etc) | Per-mission `pyspedas.<mission>.mag()` signatures differ — no universal kwarg set. | `probes.py` uses per-mission-specific kwargs verified against upstream master: STEREO `datatype="8hz"`, Wind `"h3-rtn"`, ACE keeps `"h3"` (GSE — fine for PVI). |
| Picker switches to E20 but shows E24 data | Old fanout SHA didn't emit `latest_{E20-E24}.json`, so picker falls back to `latest.json`. | Re-dispatch fanout (now writes per-perihelion JSON) or run `helio-mirror-forecast.yml` per perihelion. |
| `n_probe_pairs_matched / n_candidate` is 95% but `median_probe_match_score` is 0.29 | Tolerances (±20° lon, ±24 h time) too wide. Almost every event finds *some* event within window. | Dashboard flags as "loose". Tighten via `HELIO_LON_TOL_DEG` / `HELIO_T_TOL_WIND_H` env vars in the orchestrator. |

### Resource sanity check

GitHub Actions free tier: ~2000 min/month. Cost per run:

| Workflow | Approx CI minutes |
|---|---|
| `helio-mirror-pull` | 3 min |
| `helio-mirror-register` | 1 min |
| `helio-mirror-detect` | 1 min |
| `helio-mirror-coincide` | 1 min |
| `helio-mirror-calibrate` | 1 min |
| `helio-mirror-forecast` | 1 min |
| `helio-mirror-status` | 1 min |
| `helio-mirror-all` | ~9 min |
| `helio-mirror-fanout` | ~45 min total (5 × 9 min serial, parallel CI clock = 9 min) |

Weekly cron uses ~36 min/month. Fanout once per code change ≈ 45 min. Plenty
of headroom.

## Adding a new stage

1. Write `helio-mirror/<name>.py` with a `main()` that opens a `Gate`
   context manager and delegates to `_main_inner()`:
   ```python
   from gates import Gate
   def main() -> int:
       ...
       with Gate("<stage>", PERIHELION, REPO_ID, api=api) as g:
           rc = _main_inner(token, api, g)
       return rc
   ```
   Set `g.n_inputs`, `g.n_outputs`, `g.notes`, `g.ok`, `g.reason` at end.
   This emits `gates/<stage>_<P>.json` that the dashboard picks up.
2. Use `from hf_push import push as _push` (single file) or `push_folder`
   (batch a folder into one HF commit — preferred since HF caps 128
   commits/hour). Both retry 429/5xx with backoff.
3. Add a workflow `helio-mirror-<name>.yml` cloning the pattern of an
   existing single-stage workflow (`helio-mirror-detect.yml` is the
   simplest template).
4. Add the new stage to `helio-mirror-all.yml`'s job step list.
5. Add the new stage to `helio-mirror-fanout.yml`'s job step list.
6. Add a line to the stages table in `README.md`.
7. Add the stage prefix to `STAGES` in `status.py` if it produces a
   distinct HF folder.

## Common gotchas

- **Timestamps with timezones**: pandas merges blow up if one side has
  tz-aware timestamps and the other doesn't. Every stage normalises via
  `pd.to_datetime(...).dt.tz_localize(None)` — keep this when adding code.

- **`workflow_dispatch` requires the workflow file to be on the default
  branch.** Pushing to a feature branch and trying to dispatch it via the
  API returns 404 with no useful hint.

- **JPL Horizons rate-limits friendly-but-finitely.** One body × one
  perihelion = one query of ~120 rows. 5 perihelia × ~15 bodies =
  75 queries per fanout, which is fine. Don't blow this up to e.g. all
  perihelia × all bodies × 1-min cadence; you'll hit it.

- **HF dataset size is unbounded but file count over ~10k slows the
  web UI.** We're at ~60 files; plenty of room.

- **Cloudflare Pages auto-deploys on push to `main`.** No manual deploy
  step. The dashboard at `ask-meridian.uk/helio/` updates within ~60 s of
  a commit landing.
