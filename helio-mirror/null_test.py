#!/usr/bin/env python3
"""
Null-coincidence test — answers "is 979 matched probe-pair coincidences
on E20 actually meaningful, or would you expect that by chance given
the event density and tolerance bands?"

Null hypothesis: events at each spacecraft are timing-random (with the
same count and r/lon distribution). We permute timestamps within each
spacecraft N times and recompute matched coincidences.

Observed match count vs null distribution → an empirical p-value.

Output: events/null_test_{P}.json with:
  {observed_matched, n_shuffles, null_matches_mean, null_matches_p95,
   null_matches_p99, p_value, z_score}
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from huggingface_hub import HfApi, hf_hub_download, list_repo_files

from coincide import find_probe_coincidences
from coincide_tight import find_tight
from gates import Gate
from targets import PERIHELIA

REPO_ID = "luuow/meridian-helio-mirror"
PERIHELION = os.environ.get("HELIO_PERIHELION", "E20")
N_SHUFFLES = int(os.environ.get("HELIO_NULL_SHUFFLES", "100"))
RNG_SEED = int(os.environ.get("HELIO_NULL_SEED", "42"))
MODE = os.environ.get("HELIO_NULL_MODE", "loose")   # "loose" or "tight"


def load(token: str, name: str) -> pd.DataFrame:
    files = list_repo_files(REPO_ID, repo_type="dataset", token=token)
    if name not in files:
        return pd.DataFrame()
    p = hf_hub_download(repo_id=REPO_ID, repo_type="dataset",
                        filename=name, token=token)
    return pd.read_parquet(p)


def shuffle_timestamps(events: pd.DataFrame, rng: np.random.Generator) -> pd.DataFrame:
    """Permute timestamps within each spacecraft. Preserves per-spacecraft
    event count and the marginal distributions of r_au, lon — only the
    PAIRING between (when) and (where) is destroyed."""
    out = events.copy()
    for sc in out["spacecraft"].unique():
        mask = out["spacecraft"] == sc
        idx = out.index[mask]
        shuffled_ts = rng.permutation(out.loc[idx, "timestamp"].values)
        out.loc[idx, "timestamp"] = shuffled_ts
    return out


def main() -> int:
    if "HF_TOKEN" not in os.environ:
        print("ERROR: HF_TOKEN not set", file=sys.stderr)
        return 1
    token = os.environ["HF_TOKEN"]
    api = HfApi(token=token)
    if PERIHELION not in PERIHELIA:
        print(f"ERROR: unknown perihelion {PERIHELION}", file=sys.stderr)
        return 1

    with Gate("null_test", PERIHELION, REPO_ID, api=api) as gate:
        rc = _main_inner(token, api, gate)
    return rc


def _main_inner(token: str, api: HfApi, gate: Gate) -> int:
    # Reconstruct the event pool exactly like stage-4 does.
    psp_events = load(token, f"events/psp_candidate_events_{PERIHELION}.parquet")
    probe_events = load(token, f"events/probe_candidate_events_{PERIHELION}.parquet")
    eph_long = load(token, f"coords/ephemeris_long_{PERIHELION}.parquet")
    if eph_long.empty or (psp_events.empty and probe_events.empty):
        print(f"[null_test] missing inputs for {PERIHELION}", file=sys.stderr)
        gate.ok = False
        gate.reason = "missing PSP/probe events or ephemeris"
        return 1
    if not psp_events.empty:
        psp_events = psp_events.copy()
        psp_events["spacecraft"] = "PSP"
        psp_events["event_kind"] = "psp_pvi"
    if not probe_events.empty:
        probe_events = probe_events.copy()
        probe_events["event_kind"] = "probe_pvi"
    parts = [df for df in (psp_events, probe_events) if not df.empty]
    events = pd.concat(parts, ignore_index=True)
    events = events.dropna(subset=["spacecraft", "r_au", "helio_lon_deg"])
    events["timestamp"] = pd.to_datetime(events["timestamp"]).dt.tz_localize(None)
    eph_long = eph_long.copy()
    eph_long["timestamp"] = pd.to_datetime(eph_long["timestamp"]).dt.tz_localize(None)

    find_fn = find_tight if MODE == "tight" else find_probe_coincidences
    print(f"[null_test] mode={MODE} ({'physics-aware per-pair tolerances' if MODE == 'tight' else 'constant ±20°/±24h'})")

    # Observed match count (re-derived to verify against stage-4 output)
    obs = find_fn(events, eph_long)
    obs_matched = int(obs["matched"].sum()) if not obs.empty else 0
    obs_total_pairs = int(len(obs))
    print(f"[null_test] {PERIHELION} observed: {obs_matched} matched / "
          f"{obs_total_pairs} candidate pairs across "
          f"{events['spacecraft'].nunique()} spacecraft, "
          f"{len(events)} events")

    # Null distribution: shuffle timestamps within each spacecraft
    rng = np.random.default_rng(RNG_SEED)
    null_counts: list[int] = []
    for i in range(N_SHUFFLES):
        shuffled = shuffle_timestamps(events, rng)
        null_coinc = find_fn(shuffled, eph_long)
        null_matched = int(null_coinc["matched"].sum()) if not null_coinc.empty else 0
        null_counts.append(null_matched)
        if (i + 1) % 10 == 0:
            print(f"[null_test] shuffle {i+1}/{N_SHUFFLES}: "
                  f"null_matched={null_matched}, "
                  f"running mean={np.mean(null_counts):.1f}")

    null_arr = np.array(null_counts)
    null_mean = float(null_arr.mean())
    null_std = float(null_arr.std(ddof=1)) if len(null_arr) > 1 else 0.0
    p_value = float(np.mean(null_arr >= obs_matched)) if len(null_arr) > 0 else 1.0
    z_score = ((obs_matched - null_mean) / null_std) if null_std > 0 else 0.0

    result = {
        "perihelion": PERIHELION,
        "mode": MODE,
        "observed_matched": obs_matched,
        "observed_total_pairs": obs_total_pairs,
        "n_events_total": int(len(events)),
        "n_spacecraft": int(events["spacecraft"].nunique()),
        "n_shuffles": N_SHUFFLES,
        "rng_seed": RNG_SEED,
        "null_matches_mean": round(null_mean, 2),
        "null_matches_std": round(null_std, 2),
        "null_matches_p95": float(np.percentile(null_arr, 95)),
        "null_matches_p99": float(np.percentile(null_arr, 99)),
        "p_value_one_sided": p_value,
        "z_score": round(z_score, 3),
        "verdict": (
            "significant" if p_value < 0.01 else
            "marginal" if p_value < 0.05 else
            "indistinguishable from null"
        ),
    }
    print(json.dumps(result, indent=2))

    out_dir = Path("helio_cache/events")
    out_dir.mkdir(parents=True, exist_ok=True)
    name_suffix = "" if MODE == "loose" else f"_{MODE}"
    out_path = out_dir / f"null_test{name_suffix}_{PERIHELION}.json"
    out_path.write_text(json.dumps(result, indent=2))
    from hf_push import push as _push
    _push(api, REPO_ID, out_path, f"events/{out_path.name}",
          f"null_test ({MODE}): {N_SHUFFLES} shuffles for {PERIHELION} "
          f"(z={z_score:.2f}, p={p_value:.3f})")
    gate.n_inputs = int(len(events))
    gate.n_outputs = obs_matched
    gate.notes = {
        "n_shuffles": N_SHUFFLES,
        "z_score": z_score,
        "p_value": p_value,
        "verdict": result["verdict"],
        "observed": obs_matched,
        "null_mean": null_mean,
    }
    if p_value >= 0.05:
        gate.reason = (f"matched count {obs_matched} indistinguishable from "
                        f"null (mean {null_mean:.1f}, p={p_value:.3f}) — "
                        "tolerances saturate the event density")
    return 0


if __name__ == "__main__":
    sys.exit(main())
