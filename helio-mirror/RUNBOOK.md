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
fits per-body Ridge. Skips bodies with <10 pairs (status `gated_insufficient_data`).
With our current cadence (≈1 JWST obs per body per perihelion), this WILL gate
until items 1–2 of `ROADMAP.md` give us more data per body.

### Refresh just the dataset health summary

```bash
gh workflow run helio-mirror-status.yml -R LuuOW/meridian-mcp
```

Reads the file tree on HF, emits `forecast/dataset_status.json` for the
dashboard's pipeline-state panel. Fast (no compute).

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

1. Write `helio-mirror/<name>.py` with a `main()` that returns 0/1.
2. Use `from hf_push import push as _push; _push(api, REPO_ID, local, repo_path, msg)`
   for HF uploads — gets retry-on-429 for free.
3. Add a workflow `helio-mirror-<name>.yml` cloning the pattern of an
   existing single-stage workflow (`helio-mirror-detect.yml` is the
   simplest template).
4. Add the new stage to `helio-mirror-all.yml`'s job step list.
5. Add the new stage to `helio-mirror-fanout.yml`'s job step list.
6. Add a line to the stages table in `README.md`.

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
