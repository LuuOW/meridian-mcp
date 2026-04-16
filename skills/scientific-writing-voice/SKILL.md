---
name: scientific-writing-voice
description: Voice and structure rules for science journalism prose — the register used by Quanta Magazine, Nature News, New Scientist research features, and high-caliber popular-science briefs. Use when summarizing a technical paper for a physics-literate but time-constrained reader, drafting research digests, or writing a "brief" that preserves quantitative precision without jargon walls.
keywords: ["scientific", "writing", "voice", "quanta", "magazine", "nature", "news", "new", "scientist", "use", "research", "structure", "rules", "science", "journalism", "prose", "register", "features"]
orb_class: moon
---

# scientific-writing-voice

## When to invoke
- Writing a 200–800 word brief of a technical paper
- Drafting newsletter prose about research
- Calibrating an LLM system prompt that asks for science-journalism tone
- Editing a colleague's overly-hedged academic text toward a broader readership

## The target register (what "Quanta-meets-Nature" actually means)

1. **Precise without being technical.** Keep every quantitative claim (masses in MeV/c², statistical significance in σ, redshifts, temperatures). Strip the *derivation apparatus* (equations, Feynman diagrams, group-theoretic notation) — you're conveying *what was found*, not *how to reproduce it*.
2. **Confident, not hedging.** Avoid "the authors claim / suggest / argue". State the finding. If you want to qualify, say "*Under the assumption that dark matter couples only through the Higgs portal,* the mass window narrows to…". Write conditions as conditions, not as linguistic hedges.
3. **Active voice, concrete subjects.** Not "*it was observed that*" — "*The Parkes Pulsar Timing Array observed…*".
4. **Lead with the discovery, not the context.** Readers of a brief have ~30 seconds to decide if they care.
5. **Short paragraphs (2–4 sentences).** White space is a navigation aid.

## Canonical structure (200–600 words)

### TL;DR — one sentence, ≤40 words
Opens with a boldface `**TL;DR:**`. Names the phenomenon, the chief numerical result, and the setting.

> **TL;DR:** Scalar-tensor mixing during a brief early matter-dominated epoch generates a stochastic gravitational-wave background in the nanohertz band compatible with the NANOGrav 15-year excess.

### ¶1 — What was studied
Name the system, the measurement or simulation, the scale. Do **not** explain what a pulsar timing array is unless the paper's novelty depends on it.

### ¶2 — How
Methodology in 2–4 sentences. Instruments, sample sizes, statistical frameworks. Mention what separates this attempt from prior work (*"the first analysis that jointly fits the spectral index and amplitude"*).

### ¶3 — What they found
The quantitative heart. **Always preserve numbers and their uncertainties.** "*A strain amplitude of 2.4×10⁻¹⁵ at 1 yr⁻¹, consistent with…*" Preserve confidence intervals, priors, Bayes factors.

### ¶4 — Why it matters / caveats
- Matters: what it lets us conclude, or what it rules out, or what next
- Caveats: known systematics, alternative explanations the authors acknowledge, any crucial assumption
End the brief here. Don't editorialize. Don't speculate beyond the paper.

## Words to avoid (almost always)

| Avoid | Prefer |
|---|---|
| "paradigm shift" | the specific shift |
| "novel" | describe what's new |
| "researchers believe" | state what the data show + caveat |
| "groundbreaking" | the concrete implication |
| "first of its kind" | the actual precedent being broken |
| "scientists have long wondered" | "a standard question in X is…" |
| "a new study suggests" | state the result, then cite |
| "could pave the way" | speak to the actual near-term implication |

## Words to *keep* (signals of precision worth preserving)

- Quantitative: σ, Hz, GeV, pc, arcsec, Myr, z, h⁻¹, TeV, J/K, Bayes factor, FAR
- Qualifiers that *are* information: "*at 3.2σ local significance (2.1σ global)*", "*within 1-σ of the Gaussian prior*", "*marginalizing over nuisance parameters*"
- Named instruments: NANOGrav 15-yr, LIGO-Virgo O4, JWST/NIRCam, Planck 2018
- Named frameworks: ΛCDM, Standard Model, Wilsonian RG, AdS/CFT, VQE

## Anti-patterns for LLMs writing briefs

LLMs (including Grok) default to these — actively correct:

1. **Restating the abstract.** The brief should be *richer* than the abstract — pulling in context (what came before, what's next), NOT just paraphrasing.
2. **Vacuous openers.** "Recent advances in physics have led to…" → delete. Start with the finding.
3. **Bullet lists for flow prose.** Briefs are short articles, not spec sheets. Only use bullets for enumerated *quantitative* results (limits, couplings, redshifts at specific epochs).
4. **Hedging cascade.** "The authors propose that their model *may* suggest *a possible* connection." Cut to: "The model predicts X (probability P)."
5. **Final paragraph "this could have implications for…"** Delete. Either there's a concrete implication — name it — or there isn't. Don't wave.

## System-prompt template for LLM briefs

```
You are a science editor writing for a physics-literate but time-constrained reader.
Target: 400–600 words, hard cap 800. Prose only, not bullets.

STRUCTURE:
- Single-sentence TL;DR (≤40 words), prefixed "**TL;DR:**"
- Paragraph 1: what was studied (system, scale, novelty).
- Paragraph 2: methodology (instruments, statistical framework, what distinguishes this effort).
- Paragraph 3: results (preserve ALL numerical claims, uncertainties, significance).
- Paragraph 4: why it matters + caveats. No speculation beyond the paper.

VOICE:
- Active voice. Concrete subjects.
- Confident, not hedging. State conditions as conditions, not linguistic hedges.
- Precise without derivational apparatus. No equations, no Feynman diagrams in prose.
- Preserve quantitative claims verbatim (MeV, GHz, σ, z, pc, Hz, TeV, M_⊙).
- Never say: "groundbreaking", "novel", "paradigm shift", "could pave the way".
- Do not repeat the abstract verbatim. Synthesize and contextualize.
```

## Calibration check

A brief passes the voice test when:
- A domain-adjacent researcher (grad student in a nearby subfield) reads it in ≤2 minutes and correctly identifies the core result + its scale.
- A domain expert finds no quantitative errors or vague hedging.
- Removing any sentence loses information.

If any sentence reads like it could appear unchanged in a grant application, rewrite it for clarity and specificity.
