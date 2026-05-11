"""Solar-system bodies and perihelion windows for stage 1 of helio-mirror.

NAIF IDs are JPL Horizons object identifiers. JWST target names follow the
MAST convention (uppercase, no diacritics).
"""
from __future__ import annotations
from dataclasses import dataclass


@dataclass(frozen=True)
class Body:
    name: str
    naif_id: str
    jwst_names: tuple[str, ...]


BODIES: dict[str, Body] = {
    "Earth":     Body("Earth",     "399", ()),
    "Mars":      Body("Mars",      "499", ("MARS",)),
    "Jupiter":   Body("Jupiter",   "599", ("JUPITER",)),
    "Saturn":    Body("Saturn",    "699", ("SATURN",)),
    "Uranus":    Body("Uranus",    "799", ("URANUS",)),
    "Neptune":   Body("Neptune",   "899", ("NEPTUNE",)),
    "Mercury":   Body("Mercury",   "199", ("MERCURY",)),
    "Venus":     Body("Venus",     "299", ("VENUS",)),
    "Europa":    Body("Europa",    "502", ("EUROPA",)),
    "Io":        Body("Io",        "501", ("IO",)),
    "Ganymede":  Body("Ganymede",  "503", ("GANYMEDE",)),
    "Callisto":  Body("Callisto",  "504", ("CALLISTO",)),
    "Titan":     Body("Titan",     "606", ("TITAN",)),
    "Enceladus": Body("Enceladus", "602", ("ENCELADUS",)),
}

PSP_NAIF = "-96"

PERIHELIA: dict[str, tuple[str, str]] = {
    "E20": ("2024-06-28", "2024-07-02"),
    "E21": ("2024-09-28", "2024-10-02"),
    "E22": ("2024-12-22", "2024-12-26"),
    "E23": ("2025-03-20", "2025-03-24"),
    "E24": ("2025-06-17", "2025-06-21"),
}

JWST_BODIES_DEFAULT = (
    "Mars", "Jupiter", "Saturn", "Uranus", "Neptune",
    "Europa", "Io", "Ganymede", "Callisto", "Titan", "Enceladus",
)
EPHEMERIS_BODIES_DEFAULT = (
    "Earth", "Mercury", "Venus", "Mars", "Jupiter", "Saturn",
    "Uranus", "Neptune",
    "Europa", "Io", "Ganymede", "Callisto", "Titan", "Enceladus",
)
