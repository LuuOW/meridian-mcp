---
name: uncertainty-quantification
description: How to express, preserve, and reason about uncertainty — in statistical claims, LLM outputs, API results, and your own predictions. Use when tempted to state something confidently that you should hedge, when parsing "3σ" vs "3.5σ (2σ global)" from a paper, when combining independent error estimates, or when an LLM classifier (like the depeg monitor's Grok call) returns yes/no without a probability.
---

# uncertainty-quantification

## When to invoke
- Parsing statistical claims from research papers (σ, p-value, Bayes factor, credible interval, confidence interval)
- Writing your own outputs — deciding between "certain", "likely", "possible"
- Composing probabilities from multiple independent signals
- Auditing an LLM classifier that outputs binary yes/no when a probability would be more useful
- Reconciling frequentist and Bayesian claims ("this is 3σ" vs "the posterior concentrates at…")

## The 5 families of uncertainty you'll encounter

1. **Statistical (aleatoric)** — measurement noise, sampling variance. Quantified by error bars, σ, confidence intervals.
2. **Systematic** — instrumental bias, modeling approximations, calibration drift. Usually larger than stat and harder to quote.
3. **Epistemic** — lack of knowledge that *could* be reduced with more data or better models. What Bayesian priors encode.
4. **Model uncertainty** — is the underlying model even right? (Often *the* largest uncertainty, almost never quoted)
5. **Linguistic / representational** — "we observed" vs "we infer" vs "we estimate". Words that *look* precise but hide choices.

## Decoding "3σ" (frequentist)

- σ = standard deviation. "3σ detection" = ~99.73% of Gaussian bulk; p ≈ 2.7×10⁻³ one-tailed, 2.7×10⁻⁴ two-tailed.
- **Local vs global significance** matters enormously:
  - *Local*: p-value at one specific look
  - *Global*: corrected for the "look-elsewhere effect" across many trials
  - A paper claiming "3σ local, 1.5σ global" = essentially not a detection.
- HEP convention:
  - 2–3σ: "evidence for"
  - 3–5σ: "strong evidence" (but still one trial-factor away from noise)
  - ≥5σ: "observation" / "discovery"
- Cosmology/astro convention is more relaxed; 3σ often counted as a result.

**Red flag**: a claim of "3σ" without stating local-vs-global is almost always *local only*.

## Bayesian alternatives

- **Credible interval** (CI): "with probability 95%, θ ∈ [a, b] given the data and prior"
- **Bayes factor (BF)**: ratio of likelihoods under competing hypotheses
  - BF < 3: barely worth mentioning
  - 3 ≤ BF < 20: moderate evidence
  - 20 ≤ BF < 150: strong evidence
  - BF ≥ 150: decisive
- **Posterior probability**: P(hypothesis | data) directly — the quantity most people *think* σ represents but doesn't.

When a paper reports Bayes factors, it's giving you the quantity you actually want. When it reports σ, you're getting a frequentist construct that requires trial-factor correction you may not see.

## Combining independent signals

If two measurements of the same quantity with std σ_1 and σ_2 agree, combined std is:
```
σ_combined = 1 / sqrt(1/σ_1² + 1/σ_2²)
```

For probabilities from independent Bernoulli classifiers, use log-odds:
```
logit(p_combined) = logit(p_1) + logit(p_2) - logit(prior)
```

**If you can't establish independence, don't combine.** Correlated errors suppress the combined uncertainty toward zero falsely.

## Calibration

A classifier (or LLM) is **well-calibrated** if when it says "80% confident", it's right 80% of the time across many calls.

LLMs are **systematically miscalibrated** — they express high confidence even when wrong. Observed behaviors:
- Grok/GPT/Claude in binary yes/no mode: treat "yes" as ~60-75% confidence at best, not 100%.
- Asking for a probability (`respond with JSON {"p": 0.XX}`) helps but still biased toward 0.5 or round numbers (0.7, 0.8).
- Asking for log-odds or chain-of-thought reasoning first improves calibration meaningfully.

**Practical prompt pattern for better calibration:**
```
Assess this claim. Before your answer, list:
1. Evidence supporting the claim
2. Evidence against
3. Key uncertainties
4. Reference base rate (how often is this true in general?)

Then: "p = 0.XX" where XX reflects all above.
```

## Expressing your own uncertainty

Anchors to use when you must write a claim:

| Probability | Words |
|---|---|
| ≥95% | "virtually certain", "essentially settled" |
| 80-95% | "highly likely", "strong evidence" |
| 60-80% | "probably", "likely" |
| 40-60% | "uncertain", "could go either way" |
| 20-40% | "unlikely but possible" |
| ≤20% | "improbable" |
| ≤5% | "very unlikely" |

**Don't say "possible".** Everything above 0% is possible. Quote a range or a probability.

**"Significant" is banned** unless you immediately quote the σ. Casual use conflates statistical significance with magnitude of effect.

## Auditing your output — checklist

Before publishing any claim:
1. Is the claim conditional on assumptions? State them.
2. Could systematic error dominate? Quote it or say it's unquantified.
3. Did I correct for multiple looks / trials?
4. Is my confidence word calibrated (see table above)?
5. If combining signals: are they actually independent?
6. Is the sample size large enough for the asymptotic approximation I'm using?

## Domain-specific gotchas

- **Cosmology**: Hubble tension ≈ 5σ between early-universe (CMB) and late-universe (distance ladder) H₀ measurements. That's well beyond statistical; the issue is either systematics or new physics.
- **Particle physics**: "5σ discovery" has happened and been wrong (e.g. OPERA superluminal neutrinos, 2011, later traced to a loose fiber).
- **Finance / trading**: "3σ event" happens far more often than Gaussian predicts (fat tails). Never use Gaussian σ to size tail risk.
- **ML benchmarks**: single-seed results with 0.5% difference are noise. Always demand ≥3 seeds and report the std across them.
- **Epidemiology**: odds ratio of 1.2 with wide CI is often over-interpreted in press releases. Check the CI; if it crosses 1, no effect.

## When to simply say "I don't know"

- No prior experience with this class of question.
- All available signals conflict and no independent arbiter exists.
- The question depends on a future event whose base rate is unknown.

Better to say "I don't know — here's what would change my mind" than to emit a confident guess.
