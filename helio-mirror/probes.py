#!/usr/bin/env python3
"""Per-spacecraft pyspedas fetchers for HSO mode.

Each loader tries the canonical pyspedas call, then peels the B-field RTN
time series out of the loaded tplot vars by name (variable names differ
between missions and sometimes between epochs). All return a DataFrame with
[time, B_R, B_T, B_N, source_var] or an empty frame if the load fails / no
data exists for that window.

We deliberately don't pull plasma here — most of the in-situ magnetometer
data is sufficient for event detection (PVI on |B| works), and plasma
adds non-trivial cleaning. Plasma comes in v0.4 once the MAG-only pipeline
is exercised.
"""
from __future__ import annotations

import traceback
from typing import Iterable

import pandas as pd
import pyspedas
import pytplot


def _extract_rtn(candidates: Iterable[str]) -> tuple[pd.DataFrame, str] | tuple[pd.DataFrame, None]:
    for var in candidates:
        try:
            data = pytplot.get_data(var)
        except Exception:
            continue
        if data is None or data.y is None or len(data.times) == 0:
            continue
        y = data.y
        if y.ndim != 2 or y.shape[1] < 3:
            continue
        return pd.DataFrame({
            "time": pd.to_datetime(data.times, unit="s"),
            "B_R": y[:, 0].astype(float),
            "B_T": y[:, 1].astype(float),
            "B_N": y[:, 2].astype(float),
            "source_var": var,
        }), var
    return pd.DataFrame(), None


def _safe_load(label: str, fn, *args, **kwargs) -> None:
    try:
        fn(*args, **kwargs)
    except Exception as e:
        print(f"[probes/{label}] load raised: {e}")
        traceback.print_exc()


def fetch_psp_fields(t_start: str, t_stop: str) -> pd.DataFrame:
    pytplot.del_data("*")
    _safe_load("psp.fields", pyspedas.psp.fields,
               trange=[t_start, t_stop],
               datatype="mag_rtn_4_per_cycle",
               level="l2", time_clip=True)
    df, _ = _extract_rtn([
        "psp_fld_l2_mag_RTN_4_Sa_per_Cyc",
        "psp_fld_l2_mag_RTN",
    ])
    pytplot.del_data("*")
    return df


def fetch_solo_mag(t_start: str, t_stop: str) -> pd.DataFrame:
    pytplot.del_data("*")
    _safe_load("solo.mag", pyspedas.solo.mag,
               trange=[t_start, t_stop], level="l2",
               datatype="rtn-normal", time_clip=True)
    df, _ = _extract_rtn([
        "solo_b_rtn", "solo_mag_l2_rtn",
        "B_RTN", "solo_B_RTN", "B_RTN_l2",
    ])
    pytplot.del_data("*")
    return df


def fetch_stereoa_mag(t_start: str, t_stop: str) -> pd.DataFrame:
    # pyspedas.stereo.mag has no `level` kwarg. Valid datatype: "8hz" or "32hz".
    pytplot.del_data("*")
    _safe_load("stereo.mag", pyspedas.stereo.mag,
               probe="a", trange=[t_start, t_stop],
               datatype="8hz", time_clip=True)
    df, _ = _extract_rtn([
        "BFIELDRTN", "sta_BFIELDRTN", "BFIELD",
        "sta_BFIELD", "BRTN",
    ])
    pytplot.del_data("*")
    return df


def fetch_wind_mfi(t_start: str, t_stop: str) -> pd.DataFrame:
    # h3-rtn = 11-second RTN. Default h0 is GSE-only.
    pytplot.del_data("*")
    _safe_load("wind.mfi", pyspedas.wind.mfi,
               trange=[t_start, t_stop],
               datatype="h3-rtn", time_clip=True)
    df, _ = _extract_rtn([
        "wi_h3-rtn_mfi_BRTN", "wi_h3rtn_mfi_BRTN",
        "BRTN", "wi_h0_mfi_BRTN", "wi_h0_mfi_B3GSE",
    ])
    pytplot.del_data("*")
    return df


def fetch_ace_mfi(t_start: str, t_stop: str) -> pd.DataFrame:
    # ACE/MFI publishes B in GSE only. For PVI we just need three components.
    pytplot.del_data("*")
    _safe_load("ace.mfi", pyspedas.ace.mfi,
               trange=[t_start, t_stop],
               datatype="h3", time_clip=True)
    df, _ = _extract_rtn([
        "BGSEc", "ac_h3_mfi_BGSEc", "BRTN", "Magnitude",
    ])
    pytplot.del_data("*")
    return df


def fetch_dscovr_mag(t_start: str, t_stop: str) -> pd.DataFrame:
    # DSCOVR load() has no `datatype` kwarg; instrument="mag" is the switch.
    pytplot.del_data("*")
    _safe_load("dscovr.mag", pyspedas.dscovr.mag,
               trange=[t_start, t_stop], time_clip=True)
    df, _ = _extract_rtn([
        "dsc_h0_mag_B1GSE", "dsc_h0_mag_B1RTN",
        "B1GSE", "B1RTN", "BRTN", "BGSE",
    ])
    pytplot.del_data("*")
    return df


def fetch_maven_mag(t_start: str, t_stop: str) -> pd.DataFrame:
    # MAVEN mag() does NOT accept time_clip. Default datatype is 'ss'.
    pytplot.del_data("*")
    _safe_load("maven.mag", pyspedas.maven.mag,
               trange=[t_start, t_stop], level="l2")
    df, _ = _extract_rtn([
        "OB_B", "OB_B_pl", "OB_B_pl_sunstate",
        "mvn_B_1sec", "mvn_mag_l2_OB_B",
    ])
    pytplot.del_data("*")
    return df


LOADER_MAP = {
    "psp_fields":   fetch_psp_fields,
    "solo_mag":     fetch_solo_mag,
    "stereoa_mag":  fetch_stereoa_mag,
    "wind_mfi":     fetch_wind_mfi,
    "ace_mfi":      fetch_ace_mfi,
    "dscovr_mag":   fetch_dscovr_mag,
    "maven_mag":    fetch_maven_mag,
}
