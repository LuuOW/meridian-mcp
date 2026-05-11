#!/usr/bin/env python3
"""
Compute per-filter solar zeropoints for the JWST NIRCam/MIRI filters
actually used by our pipeline, using:
  - Planck B_λ(λ, T_eff=5778 K) for the solar SED
  - Top-hat throughput approximation per filter (centre λ + FWHM)

This is intentionally simple — a percent-level estimate. Compared to the
previous arbitrary-units proxy, this is a 100× improvement in honesty.
Replacement with synphot-integrated values using STScI throughput tables
is a future refinement; the pipeline picks up whichever zeropoints
file is on HF at run time.

Output: forecast/filter_zeropoints.json
Schema:
  {
    "version": 1,
    "method": "planck_tophat",
    "TSI_W_m2_at_1au": 1361.0,
    "T_eff_K": 5778.0,
    "R_sun_m": 6.957e8,
    "filters": {
      "F200W": {"lambda_um": 1.989, "fwhm_um": 0.472, "in_band_W_m2_at_1au": ...},
      ...
    }
  }
"""
from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path

from huggingface_hub import HfApi

REPO_ID = "luuow/meridian-helio-mirror"

# Physical constants (SI)
H_PLANCK = 6.62607015e-34
C_LIGHT = 2.99792458e8
K_BOLTZ = 1.380649e-23
R_SUN_M = 6.957e8
AU_M = 1.495978707e11
T_SUN_EFF = 5778.0
TSI_W_M2_AT_1AU = 1361.0

# Filter centre wavelength + FWHM (µm). Source: STScI filter pages
# (NIRCam wide/medium/narrow + MIRI imaging filters). Numbers cross-checked
# against jwst-docs but should be replaced with throughput-integrated values
# in a future revision.
FILTERS = {
    # NIRCam wide
    "F070W":  (0.704, 0.132),
    "F090W":  (0.901, 0.194),
    "F115W":  (1.154, 0.225),
    "F150W":  (1.501, 0.318),
    "F200W":  (1.989, 0.461),
    "F277W":  (2.776, 0.672),
    "F356W":  (3.563, 0.787),
    "F444W":  (4.401, 1.024),
    # NIRCam medium
    "F140M":  (1.404, 0.142),
    "F162M":  (1.626, 0.169),
    "F182M":  (1.845, 0.238),
    "F210M":  (2.093, 0.205),
    "F250M":  (2.503, 0.179),
    "F300M":  (2.989, 0.318),
    "F335M":  (3.362, 0.347),
    "F360M":  (3.621, 0.372),
    "F410M":  (4.082, 0.436),
    "F430M":  (4.281, 0.228),
    "F460M":  (4.626, 0.227),
    "F480M":  (4.834, 0.303),
    # NIRCam narrow
    "F164N":  (1.644, 0.020),
    "F187N":  (1.874, 0.024),
    "F212N":  (2.120, 0.027),
    "F323N":  (3.237, 0.038),
    "F405N":  (4.052, 0.046),
    "F466N":  (4.654, 0.054),
    "F470N":  (4.708, 0.051),
    # MIRI imaging
    "F560W":  (5.6,   1.20),
    "F770W":  (7.7,   2.20),
    "F1000W": (10.0,  2.00),
    "F1130W": (11.3,  0.70),
    "F1280W": (12.8,  2.40),
    "F1500W": (15.0,  3.00),
    "F1800W": (18.0,  3.00),
    "F2100W": (21.0,  5.00),
    "F2550W": (25.5,  4.00),
}


def planck_B_lambda(lam_m: float, T_K: float) -> float:
    """Planck spectral radiance B_λ in W/m²/sr/m."""
    a = (2.0 * H_PLANCK * C_LIGHT ** 2) / (lam_m ** 5)
    b = (H_PLANCK * C_LIGHT) / (lam_m * K_BOLTZ * T_K)
    return a / (math.exp(b) - 1.0)


def solar_F_lambda_at_1au(lam_m: float) -> float:
    """Solar spectral irradiance F_λ at 1 AU, W/m²/m, using Planck × geometric
    dilution from solar surface to 1 AU. Surface emission is π·B_λ
    (Lambertian)."""
    surface_flux_W_per_m2_per_m = math.pi * planck_B_lambda(lam_m, T_SUN_EFF)
    return surface_flux_W_per_m2_per_m * (R_SUN_M / AU_M) ** 2


def integrate_tophat(centre_um: float, fwhm_um: float, n_sub: int = 64) -> float:
    """Trapezoidal integral of F_λ over a top-hat from centre-FWHM/2 to
    centre+FWHM/2. Returns W/m² at 1 AU in that band."""
    lam_lo = (centre_um - fwhm_um / 2) * 1e-6
    lam_hi = (centre_um + fwhm_um / 2) * 1e-6
    if lam_lo <= 0 or lam_hi <= lam_lo:
        return 0.0
    step = (lam_hi - lam_lo) / n_sub
    total = 0.0
    for i in range(n_sub + 1):
        lam = lam_lo + i * step
        f = solar_F_lambda_at_1au(lam)
        total += (0.5 if i == 0 or i == n_sub else 1.0) * f
    return total * step


def main() -> int:
    if "HF_TOKEN" not in os.environ:
        print("ERROR: HF_TOKEN not set", file=sys.stderr)
        return 1
    token = os.environ["HF_TOKEN"]
    api = HfApi(token=token)

    out_filters: dict[str, dict] = {}
    for name, (centre, fwhm) in FILTERS.items():
        flux_W_m2 = integrate_tophat(centre, fwhm)
        out_filters[name] = {
            "lambda_um": centre,
            "fwhm_um": fwhm,
            "in_band_W_m2_at_1au": round(flux_W_m2, 6),
        }
    # Sanity: sum should be a noticeable fraction of TSI but <= TSI
    total = sum(f["in_band_W_m2_at_1au"] for f in out_filters.values())
    print(f"[zeropoints] sum across {len(out_filters)} filters: "
          f"{total:.2f} W/m² (TSI = {TSI_W_M2_AT_1AU}). "
          "Should be < TSI since filters don't cover the whole spectrum and overlap.")

    payload = {
        "version": 1,
        "method": "planck_tophat",
        "TSI_W_m2_at_1au": TSI_W_M2_AT_1AU,
        "T_eff_K": T_SUN_EFF,
        "R_sun_m": R_SUN_M,
        "filters": out_filters,
        "notes": "Top-hat approximation of filter throughput, Planck-blackbody "
                 "solar SED at T_eff=5778 K. Replace with synphot-integrated "
                 "values when a STScI throughput dataset is integrated.",
    }

    out_dir = Path("helio_cache/forecast")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "filter_zeropoints.json"
    out_path.write_text(json.dumps(payload, indent=2))

    from hf_push import push as _push
    _push(api, REPO_ID, out_path, "forecast/filter_zeropoints.json",
          "calibration: filter zeropoints (planck_tophat)")
    print(f"[zeropoints] pushed {out_path.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
