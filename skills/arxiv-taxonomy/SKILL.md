---
name: arxiv-taxonomy
description: Complete arXiv category taxonomy, cross-listing rules, submission conventions, and query patterns. Use when fetching, filtering, or routing papers by discipline; when a user references "astro-ph.CO" or "hep-ph" and you need to know what that covers; when building recommender logic across adjacent categories.
---

# arxiv-taxonomy

## When to invoke
- Building an arXiv query (wildcards, cross-listings, OR combinations)
- Interpreting a paper's `primary_category` vs secondary
- Recommending adjacent categories to a user interested in X
- Explaining to a user why a paper on gravitational waves shows up in *both* `astro-ph.HE` and `gr-qc`

## Top-level archives

| Archive | Full name | Typical content |
|---|---|---|
| `astro-ph` | Astrophysics | Observations, simulations, theory of astrophysical objects |
| `cond-mat` | Condensed Matter | Solids, liquids, soft matter, quantum materials |
| `cs` | Computer Science | Includes CS.LG (ML), CS.AI, CS.CL (NLP), CS.CR (security), 40+ sub-fields |
| `econ` | Economics | Econometrics, theory, general |
| `eess` | Electrical Eng & Systems Science | Signal processing, image/video proc., systems & control |
| `gr-qc` | General Relativity & Quantum Cosmology | GR, gravitational waves, black holes, quantum gravity, cosmology interfaces |
| `hep-ex` | High-Energy Physics — Experiment | Collider, neutrino, flavor physics results |
| `hep-lat` | High-Energy Physics — Lattice | Lattice QCD, numerical gauge theory |
| `hep-ph` | High-Energy Physics — Phenomenology | BSM, SM precision, collider predictions |
| `hep-th` | High-Energy Physics — Theory | QFT, strings, CFT, SUSY, holography |
| `math` | Mathematics | 32 subfields (AG, AT, CA, NT, PR…) |
| `math-ph` | Mathematical Physics | Rigorous math underlying physics |
| `nlin` | Nonlinear Sciences | Chaos, dynamical systems, solitons |
| `nucl-ex` | Nuclear — Experiment | Heavy-ion, nuclear structure experiments |
| `nucl-th` | Nuclear — Theory | Nuclear structure & reaction theory |
| `physics` | General Physics | Accelerator physics, atomic, biological, chemical, optics, plasma, 25+ sub-fields |
| `q-bio` | Quantitative Biology | Genomics, neurons, populations |
| `q-fin` | Quantitative Finance | Pricing, risk, econometrics of finance |
| `quant-ph` | Quantum Physics | Foundations, QI/QC, quantum optics, many-body |
| `stat` | Statistics | Machine learning, applications, methodology, theory |

## Critical sub-categories (astro-ph)

astro-ph has **6 subs** — always query with wildcard `cat:astro-ph*` to catch all:

| Sub | Focus |
|---|---|
| `astro-ph.CO` | Cosmology & Nongalactic Astrophysics (CMB, dark energy, large-scale structure) |
| `astro-ph.EP` | Earth & Planetary Astrophysics (exoplanets, solar system) |
| `astro-ph.GA` | Galactic & Extragalactic Astrophysics (Milky Way, external galaxies, AGN) |
| `astro-ph.HE` | High-Energy Astrophysics (GRBs, neutron stars, cosmic rays, high-E cosmology overlap) |
| `astro-ph.IM` | Instrumentation & Methods (telescopes, pipelines, software) |
| `astro-ph.SR` | Solar & Stellar Astrophysics (stellar structure, evolution, helioseismology) |

## High-value cross-listings (papers often submitted to both)

Knowing these pairs dramatically improves filter recall:

| A | B | Why |
|---|---|---|
| `gr-qc` | `astro-ph.CO` | Gravitational waves, early universe, modified gravity |
| `gr-qc` | `astro-ph.HE` | Black hole / neutron star astrophysics |
| `gr-qc` | `hep-th` | Quantum gravity, AdS/CFT, holography |
| `hep-ph` | `astro-ph.CO` | Dark matter candidates, baryogenesis |
| `hep-ph` | `astro-ph.HE` | Cosmic ray composition, high-E neutrinos |
| `hep-ph` | `hep-ex` | Any theory/experiment interplay paper |
| `hep-th` | `math-ph` | Formal aspects |
| `quant-ph` | `cond-mat.str-el` | Topological phases, many-body physics |
| `quant-ph` | `physics.atom-ph` | Trapped ions, cold atoms |
| `quant-ph` | `physics.optics` | Photonic qubits, quantum networks |
| `cs.LG` | `stat.ML` | Nearly every ML paper is dual |
| `cs.CL` | `cs.AI` | Nearly all NLP+LLM papers |
| `q-bio.NC` | `cs.NE` | Computational neuroscience |

## Query patterns (arxiv API)

```
# Whole archive (including all subs):
cat:astro-ph*       # use wildcard

# Specific sub:
cat:astro-ph.CO

# Union of two archives:
cat:gr-qc OR cat:hep-th

# Archive + date range (use submittedDate field):
cat:quant-ph AND submittedDate:[202601010000 TO 202604010000]

# Keywords in title/abstract only:
ti:"neutron star" AND abs:"binary"

# Combined:
(cat:astro-ph.HE OR cat:gr-qc) AND abs:"gravitational wave"
```

## Categorical sortBy values

- `relevance` — default, poor for recent-papers workflows
- `lastUpdatedDate` — includes revisions (can be misleading)
- `submittedDate` — **use this for "recent" queries**

Plus `sortOrder=descending` or `ascending`.

## Rate etiquette

- arXiv expects you to cache. Re-poll no more than every 3 s.
- If scraping listings in bulk (>1000 results), insert `delay` between calls ≥3 s.
- Use a User-Agent identifying your tool. Example:
  `User-Agent: my-research-tool/1.0 (contact: you@example.com)`
- 503s on hot endpoints — back off exponentially from 30 s.

## Paper ID anatomy

Format (post-2007): `YYMM.NNNNN` + optional version.
- `2604.13012v1` — April 2026, submission 13012, v1
- Year+month encodes **submission date**, not publication. Two papers with same YYMM.xxxxx were submitted on adjacent days.

Legacy format (pre-2007): `archive.subfield/YYMMnnn` e.g. `hep-th/9901139`.

## Cross-field tags most relevant to a physics-paper reader

When user says "quantum optics", they want the union of:
- `quant-ph` (primary)
- `physics.optics`
- `physics.atom-ph` (cold atoms, ion traps)
- sometimes `cond-mat.mes-hall` (mesoscopic)

When user says "cosmology", union:
- `astro-ph.CO` (primary)
- `gr-qc`
- `hep-ph` (dark matter, baryogenesis)
- `hep-th` (inflation models, holography interfaces)

When user says "dark matter", union:
- `hep-ph`
- `astro-ph.CO`
- `astro-ph.HE` (indirect detection)
- sometimes `physics.ins-det` (direct detection experiments)
