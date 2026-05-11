"""Per-spacecraft solar wind speed loaders (v_sw).

Returns a DataFrame with [time, v_sw_km_s, source_var] or empty frame on
miss. We deliberately store only the scalar |V| because coincide.py uses
it as the Parker-spiral advection speed for transit-time prediction;
3-vector velocity is overkill for that purpose.

Coverage in practice:
- ACE/SWEPAM at L1: reliable, 64s cadence
- Wind/SWE at L1: reliable, varies by datatype
- DSCOVR/FC at L1: reliable but gappy
- PSP/SWEAP-SPI: VERY gappy at deep perihelia (data dropouts inside ~0.1 AU)
- STEREO/PLASTIC: usually reliable
- SolO/SWA: variable

When a source spacecraft has no plasma data, coincide.py falls back to the
v_sw=400 km/s constant — so this stage is opportunistic, not gating.
"""
from __future__ import annotations

import traceback
from typing import Iterable

import numpy as np
import pandas as pd
import pyspedas
import pytplot


def _extract_speed_from_vec(candidates: Iterable[str]) -> tuple[pd.DataFrame, str] | tuple[pd.DataFrame, None]:
    """Look up tplot vars; for vector-valued (3-component) variables compute
    speed = sqrt(vx^2 + vy^2 + vz^2). Returns (df, var_used) or (empty, None)."""
    for var in candidates:
        try:
            data = pytplot.get_data(var)
        except Exception:
            continue
        if data is None or data.y is None or len(data.times) == 0:
            continue
        y = data.y
        if y.ndim == 1:
            speed = np.abs(y)
        elif y.ndim == 2 and y.shape[1] >= 3:
            speed = np.linalg.norm(y[:, :3], axis=1)
        else:
            continue
        # Filter obvious fill values (negative or huge)
        mask = (speed > 50) & (speed < 3000)
        if mask.sum() == 0:
            continue
        return pd.DataFrame({
            "time": pd.to_datetime(data.times[mask], unit="s"),
            "v_sw_km_s": speed[mask].astype(float),
            "source_var": var,
        }), var
    return pd.DataFrame(), None


def _safe_load(label: str, fn, *args, **kwargs) -> None:
    try:
        fn(*args, **kwargs)
    except Exception as e:
        print(f"[plasma/{label}] load raised: {e}")
        traceback.print_exc()


def fetch_ace_swepam(t_start: str, t_stop: str) -> pd.DataFrame:
    pytplot.del_data("*")
    _safe_load("ace.swe", pyspedas.ace.swe,
               trange=[t_start, t_stop], datatype="h0", time_clip=True)
    df, _ = _extract_speed_from_vec([
        "Vp", "V_GSE", "ac_h0_swe_Vp", "ac_h0_swe_V_GSE", "SW_H_speed",
    ])
    pytplot.del_data("*")
    return df


def fetch_wind_swe(t_start: str, t_stop: str) -> pd.DataFrame:
    pytplot.del_data("*")
    # h1 is best for nonlinear-fit moments; h5 is the K0 ion params.
    _safe_load("wind.swe", pyspedas.wind.swe,
               trange=[t_start, t_stop], datatype="h1", time_clip=True)
    df, _ = _extract_speed_from_vec([
        "Proton_V_nonlin", "Proton_VX_nonlin", "V_GSE", "Proton_VX_moment",
        "wi_h1_swe_Proton_V_nonlin", "SW_speed",
    ])
    pytplot.del_data("*")
    return df


def fetch_dscovr_fc(t_start: str, t_stop: str) -> pd.DataFrame:
    pytplot.del_data("*")
    _safe_load("dscovr.fc", pyspedas.dscovr.fc,
               trange=[t_start, t_stop], time_clip=True)
    df, _ = _extract_speed_from_vec([
        "dsc_h1_fc_V_GSE", "dsc_h1_fc_Np", "V_GSE", "Vp",
    ])
    pytplot.del_data("*")
    return df


def fetch_stereoa_plastic(t_start: str, t_stop: str) -> pd.DataFrame:
    # Only valid datatype is "1min" per pyspedas; level="l2".
    pytplot.del_data("*")
    _safe_load("stereo.plastic", pyspedas.stereo.plastic,
               probe="a", trange=[t_start, t_stop],
               datatype="1min", level="l2", time_clip=True)
    df, _ = _extract_speed_from_vec([
        "proton_bulk_speed", "STA_L2_PLA_1DMax_speed", "Vp", "proton_speed",
    ])
    pytplot.del_data("*")
    return df


def fetch_solo_swa(t_start: str, t_stop: str) -> pd.DataFrame:
    # Default datatype is pas-eflux (energy flux). We want bulk moments —
    # try pas-grnd-mom first, fall back to others if upstream renames.
    pytplot.del_data("*")
    _safe_load("solo.swa", pyspedas.solo.swa,
               trange=[t_start, t_stop], datatype="pas-grnd-mom",
               level="l2", time_clip=True)
    df, _ = _extract_speed_from_vec([
        "V_RTN", "solo_swa_pas_grnd_mom_V_RTN", "Vp",
        "solo_swa_pas_grnd_mom_V_SRF", "proton_bulk_speed",
    ])
    pytplot.del_data("*")
    return df


def fetch_psp_spi(t_start: str, t_stop: str) -> pd.DataFrame:
    # sf00_l3_mom = SPI proton distribution moments. tplot vars often
    # follow the pattern "psp_swp_spi_<datatype>_<quantity>".
    pytplot.del_data("*")
    _safe_load("psp.spi", pyspedas.psp.spi,
               trange=[t_start, t_stop], datatype="sf00_l3_mom",
               level="l3", time_clip=True)
    df, _ = _extract_speed_from_vec([
        "psp_swp_spi_sf00_l3_mom_VEL_RTN_SUN",
        "psp_swp_spi_sf00_VEL_RTN_SUN",
        "psp_spi_VEL_RTN_SUN", "VEL_RTN_SUN",
        "psp_swp_spi_sf00_l3_mom_VEL_SC",
        "psp_spi_VEL_SC",
    ])
    pytplot.del_data("*")
    return df


LOADER_MAP = {
    "ACE":      fetch_ace_swepam,
    "Wind":     fetch_wind_swe,
    "DSCOVR":   fetch_dscovr_fc,
    "STEREO-A": fetch_stereoa_plastic,
    "SolO":     fetch_solo_swa,
    "PSP":      fetch_psp_spi,
    # MAVEN intentionally omitted — solar wind there is altered by Mars
}
