---
name: physics-units-si
description: SI units, CODATA constants, dimensional analysis, and rigorous unit conversion. Use when extracting, normalizing, or computing physical quantities (energy, frequency, length, mass, time, temperature). Handles eV/keV/MeV/GeV/TeV, Hz/kHz/MHz/GHz/THz, meter/cm/Å/fm, kg/g/u, second/ms/μs/ns/fs, Kelvin/eV-temperature equivalents.
---

# physics-units-si

## When to invoke
- Parsing physics abstracts or papers for numerical quantities
- Converting between units in a calculation
- Validating that a computed quantity has the expected dimension
- Building a regex/parser that extracts "100 GeV" or "4.7 GHz" from free text
- Writing output that mixes orders of magnitude (always show canonical form)

## Canonical base-unit table

### Energy — base: **GeV** (high-energy physics convention) OR **joule** (SI).
| Unit | SI (joules) | GeV |
|---|---|---|
| eV | 1.602176634e-19 | 1e-9 |
| keV | 1.602176634e-16 | 1e-6 |
| MeV | 1.602176634e-13 | 1e-3 |
| GeV | 1.602176634e-10 | 1.0 |
| TeV | 1.602176634e-7 | 1e3 |
| PeV | 1.602176634e-4 | 1e6 |
| EeV | 0.1602176634 | 1e9 |
| erg | 1e-7 | 6.242e2 |
| joule | 1 | 6.242e9 |

### Frequency — base: **Hz**.
| Unit | Hz |
|---|---|
| Hz | 1 |
| kHz | 1e3 |
| MHz | 1e6 |
| GHz | 1e9 |
| THz | 1e12 |
| PHz | 1e15 |

### Length — base: **meter**.
| Unit | meters |
|---|---|
| fm | 1e-15 |
| pm | 1e-12 |
| Å | 1e-10 |
| nm | 1e-9 |
| μm / um | 1e-6 |
| mm | 1e-3 |
| cm | 1e-2 |
| km | 1e3 |
| au | 1.495978707e11 |
| ly | 9.4607304725808e15 |
| pc | 3.0856775814913673e16 |

### Mass — base: **kg**.
| Unit | kg |
|---|---|
| u (atomic) | 1.66053906892e-27 |
| g | 1e-3 |
| ton | 1e3 |
| solar mass (M☉) | 1.98892e30 |

### Time — base: **second**.
Standard SI prefixes apply (fs, ps, ns, μs, ms, s, min=60 s, h=3600 s, day=86400 s, yr≈3.155693e7 s).

## CODATA constants (memorize — 2018 CODATA values)

| Symbol | Name | Value |
|---|---|---|
| c | Speed of light in vacuum | **299792458 m/s** (exact, SI defn) |
| h | Planck constant | **6.62607015e-34 J·s** (exact) |
| ℏ | Reduced Planck | 1.054571817e-34 J·s |
| e | Elementary charge | **1.602176634e-19 C** (exact) |
| G | Gravitational const | 6.67430e-11 m³/(kg·s²)  (±2.2e-15) |
| k_B | Boltzmann | **1.380649e-23 J/K** (exact) |
| N_A | Avogadro | **6.02214076e23 /mol** (exact) |
| α | Fine-structure | 7.2973525693e-3 (≈1/137.035999) |
| m_e | Electron mass | 9.1093837015e-31 kg = 0.51099895 MeV/c² |
| m_p | Proton mass | 1.67262192369e-27 kg = 938.27208816 MeV/c² |
| m_n | Neutron mass | 1.67492749804e-27 kg = 939.56542052 MeV/c² |
| R_∞ | Rydberg | 1.0973731568160e7 /m |
| σ | Stefan-Boltzmann | 5.670374419e-8 W/(m²·K⁴) |

## Natural-unit cheats

Particle physics uses ℏ = c = 1, so:
- **Energy ↔ mass**: `1 GeV/c² = 1.782661921e-27 kg`
- **Energy ↔ frequency**: `E = hν`, so `1 GHz ≈ 4.1357e-6 eV`
- **Energy ↔ wavelength**: `E = hc/λ`, so `1 eV ↔ 1239.84 nm`
- **Energy ↔ temperature**: `E = k_B T`, so `1 eV ↔ 11604.5 K`
- **Distance ↔ GeV^-1**: `1 fm ≈ 5.0677 GeV^-1`

## Extraction regex (copy-paste)

```python
# Energy (all units). Returns (value, canonical_unit).
_ENERGY_RE = re.compile(
    r"(\d+(?:\.\d+)?(?:e[-+]?\d+)?)\s*(PeV|TeV|GeV|MeV|keV|eV|EeV|erg)",
    re.IGNORECASE
)
_ENERGY_MULT_GEV = {
    "eV": 1e-9, "keV": 1e-6, "MeV": 1e-3, "GeV": 1.0,
    "TeV": 1e3, "PeV": 1e6, "EeV": 1e9, "erg": 6.242e2,
}

# Frequency (all units).
_FREQ_RE = re.compile(
    r"(\d+(?:\.\d+)?(?:e[-+]?\d+)?)\s*(THz|GHz|MHz|kHz|Hz|PHz)",
    re.IGNORECASE
)
_FREQ_MULT_HZ = {
    "Hz": 1.0, "kHz": 1e3, "MHz": 1e6, "GHz": 1e9, "THz": 1e12, "PHz": 1e15,
}
```

## Common pitfalls

1. **"eV" inside other tokens.** `1eV` in a paper like `0.5eV` parses fine, but `LeVeL` (letter V, L) should not match. Use word boundaries: `\b(?=\d)` pattern prefix if needed.
2. **Ambiguous case.** `mM` (millimolar) vs `mm` (millimeter). Always preserve case from source; don't lowercase before matching.
3. **Exponents in abstracts.** `10^{18}` eV or `10^18 eV` are frequent. Add a preprocessor step: `re.sub(r"10\s*\^\s*{?(-?\d+)}?", r"1e\1", text)`.
4. **Mass in MeV/c²** vs **energy in MeV**. Same numerical value, different dimension — track which you parsed.
5. **Inverse units.** Cross-sections in cm² and barns (1 barn = 1e-24 cm²). Rates in /s, /yr.
6. **Log-scale quantities.** Magnitudes in astronomy are negative-log flux; **not a linear unit**. Convert to Jy or W/m²/Hz before arithmetic.

## Precision rules

- Preserve input precision. Don't round `1.99e-27` to `2e-27` during conversion.
- Use `decimal.Decimal` or explicit sig-fig tracking when precision matters (<1% relative error).
- When reporting converted values, cap at input's sig figs — `4.7 GHz` → `4.7e9 Hz`, not `4.700000e9 Hz`.

## Dimensional analysis

Before computing a quantity, check that units multiply/divide to the expected result:
- Energy = mass × c² → kg × (m/s)² = kg·m²/s² = J ✓
- Frequency = energy / h → J / (J·s) = /s = Hz ✓
- Cross-section × flux = rate → cm² × /cm²/s = /s ✓

If dimensions don't match, the computation is wrong regardless of numeric value.
