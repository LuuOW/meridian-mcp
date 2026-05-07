#!/usr/bin/env node
// Compare CI methods for binomial proportions on our actual eval data.
//
// Bootstrap (10,000 resamples) is what we shipped in 2.2.1. For a
// binomial success rate k/n, four alternatives exist with much lower
// computational cost:
//
//   • Wilson score interval        — closed-form, asymptotic
//   • Clopper-Pearson exact        — exact coverage via binomial CDF
//   • Jackknife (leave-one-out)    — n evals, similar to bootstrap
//   • Bayesian Beta(1,1) credible  — closed-form posterior, philosophically different
//
// What we want to know:
//   1. Do they give similar answers on our actual 17/21 data?
//   2. Which has correct empirical coverage at small n?
//   3. Which is tightest at correct coverage (minimum width subject to ≥0.95 actual)?
//
// Verdict drives whether to replace bootstrap in eval-against-public-data.mjs.

import { readFileSync } from 'node:fs'

// ── Helpers: binomial CDF (exact via log-gamma) ─────────────────────
function logFact(n) {
  let s = 0
  for (let i = 2; i <= n; i++) s += Math.log(i)
  return s
}
function logBinomCoeff(n, k) {
  return logFact(n) - logFact(k) - logFact(n - k)
}
function binomCDF(k, n, p) {
  // P(X ≤ k)
  if (p <= 0) return 1
  if (p >= 1) return k >= n ? 1 : 0
  let cdf = 0
  const lp = Math.log(p), l1p = Math.log(1 - p)
  for (let i = 0; i <= k; i++) {
    cdf += Math.exp(logBinomCoeff(n, i) + i * lp + (n - i) * l1p)
  }
  return cdf
}

// ── Wilson score interval ───────────────────────────────────────────
function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 1]
  const p = k / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const margin = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom
  return [Math.max(0, center - margin), Math.min(1, center + margin)]
}

// ── Clopper-Pearson exact (bisection on binomial CDF) ───────────────
function clopperPearson(k, n, alpha = 0.05) {
  if (k === 0) return [0, 1 - Math.pow(alpha / 2, 1 / n)]
  if (k === n) return [Math.pow(alpha / 2, 1 / n), 1]
  // p_lo: P(X ≥ k | n, p_lo) = α/2  ⟺  P(X ≤ k-1 | n, p_lo) = 1 - α/2
  // p_hi: P(X ≤ k | n, p_hi) = α/2
  function bisect(target, kForCDF) {
    let l = 0, h = 1
    for (let i = 0; i < 80; i++) {
      const m = (l + h) / 2
      const cdf = binomCDF(kForCDF, n, m)
      if (cdf > target) l = m
      else h = m
    }
    return (l + h) / 2
  }
  const p_lo = bisect(1 - alpha / 2, k - 1)
  const p_hi = bisect(alpha / 2, k)
  return [p_lo, p_hi]
}

// ── Jackknife (delete-one) ──────────────────────────────────────────
function jackknife(arr, z = 1.96) {
  const n = arr.length
  const mean = arr.reduce((s, v) => s + v, 0) / n
  // Leave-one-out means
  const looMeans = arr.map((_, i) => {
    let s = 0
    for (let j = 0; j < n; j++) if (j !== i) s += arr[j]
    return s / (n - 1)
  })
  const looMean = looMeans.reduce((s, v) => s + v, 0) / n
  // Variance estimate: ((n-1)/n) * Σ (looMean_i - looMean)²
  const variance = ((n - 1) / n) * looMeans.reduce((s, m) => s + (m - looMean) ** 2, 0)
  const se = Math.sqrt(variance)
  return [Math.max(0, mean - z * se), Math.min(1, mean + z * se)]
}

// ── Bayesian Beta(1,1) credible interval ────────────────────────────
// Posterior is Beta(k+1, n-k+1). For integer params, Beta CDF at p
// equals P(X ≥ k+1 | X ~ Bin(n+1, p)).
function bayesianBetaCI(k, n, alpha = 0.05) {
  // Beta(a, b) CDF at p = P(X ≥ a | X ~ Bin(a+b-1, p))
  //                    = 1 - P(X ≤ a-1 | X ~ Bin(a+b-1, p))
  const a = k + 1, b = n - k + 1
  const N = a + b - 1
  function bisect(target) {
    let l = 0, h = 1
    for (let i = 0; i < 80; i++) {
      const m = (l + h) / 2
      const cdf = 1 - binomCDF(a - 1, N, m)
      if (cdf < target) l = m
      else h = m
    }
    return (l + h) / 2
  }
  const p_lo = bisect(alpha / 2)
  const p_hi = bisect(1 - alpha / 2)
  return [p_lo, p_hi]
}

// ── Bootstrap (for comparison — same as eval-against-public-data) ──
function bootstrap(arr, B = 10_000, alpha = 0.05) {
  const n = arr.length
  const samples = new Float64Array(B)
  for (let b = 0; b < B; b++) {
    let s = 0
    for (let i = 0; i < n; i++) s += arr[(Math.random() * n) | 0]
    samples[b] = s / n
  }
  samples.sort()
  return [samples[Math.floor(B * alpha / 2)], samples[Math.floor(B * (1 - alpha / 2)) - 1]]
}

// ── Apply to our actual data ────────────────────────────────────────
// recall@1: 17/21 hits  ·  recall@5: 20/21 hits  (from eval output)
const N = 21
const K1 = 17  // recall@1 hits
const K5 = 20  // recall@5 hits
const arr1 = Array.from({ length: N }, (_, i) => i < K1 ? 1 : 0)
const arr5 = Array.from({ length: N }, (_, i) => i < K5 ? 1 : 0)

function fmt(ci) { return `[${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}]   width ${(ci[1] - ci[0]).toFixed(3)}` }

console.log('CI METHODS — applied to our actual eval data (n=21)')
console.log('====================================================')
console.log('\nrecall@1   point estimate 0.810  (17/21)')
console.log(`  bootstrap (10k)        ${fmt(bootstrap(arr1))}`)
console.log(`  wilson                 ${fmt(wilson(K1, N))}`)
console.log(`  clopper-pearson exact  ${fmt(clopperPearson(K1, N))}`)
console.log(`  jackknife              ${fmt(jackknife(arr1))}`)
console.log(`  bayesian Beta(1,1)     ${fmt(bayesianBetaCI(K1, N))}`)
console.log('\nrecall@5   point estimate 0.952  (20/21)')
console.log(`  bootstrap (10k)        ${fmt(bootstrap(arr5))}`)
console.log(`  wilson                 ${fmt(wilson(K5, N))}`)
console.log(`  clopper-pearson exact  ${fmt(clopperPearson(K5, N))}`)
console.log(`  jackknife              ${fmt(jackknife(arr5))}`)
console.log(`  bayesian Beta(1,1)     ${fmt(bayesianBetaCI(K5, N))}`)

// ── Coverage simulation ─────────────────────────────────────────────
// For each true rate p_true and each method, simulate K trials of
// drawing n=21 samples and check whether the 95% CI contains p_true.
// A correctly-calibrated method should achieve ≥0.95 empirical coverage.
function coverageSim(p_true, n, K = 5000) {
  const methods = { bootstrap: 0, wilson: 0, cp: 0, jackknife: 0, bayes: 0 }
  const widths  = { bootstrap: 0, wilson: 0, cp: 0, jackknife: 0, bayes: 0 }
  for (let trial = 0; trial < K; trial++) {
    const arr = []
    let k = 0
    for (let i = 0; i < n; i++) {
      const x = Math.random() < p_true ? 1 : 0
      arr.push(x)
      k += x
    }
    const cis = {
      bootstrap: bootstrap(arr, 1000),    // 1k for speed in coverage sim
      wilson:    wilson(k, n),
      cp:        clopperPearson(k, n),
      jackknife: jackknife(arr),
      bayes:     bayesianBetaCI(k, n),
    }
    for (const [name, ci] of Object.entries(cis)) {
      if (p_true >= ci[0] && p_true <= ci[1]) methods[name]++
      widths[name] += ci[1] - ci[0]
    }
  }
  const cov = {}, w = {}
  for (const name of Object.keys(methods)) {
    cov[name] = methods[name] / K
    w[name]   = widths[name] / K
  }
  return { cov, w }
}

console.log('\n\nCOVERAGE SIMULATION  (n=21, K=5000 trials per row, target=0.95)')
console.log('================================================================')
console.log('  true_p     bootstrap          wilson             clopper-pears      jackknife          bayes(1,1)')
const TRUE_PS = [0.50, 0.70, 0.81, 0.90, 0.95]
for (const p of TRUE_PS) {
  const { cov, w } = coverageSim(p, 21, 5000)
  function cell(name) {
    const c = cov[name].toFixed(3)
    const wd = w[name].toFixed(3)
    return `${c} (w ${wd})`.padEnd(18)
  }
  console.log(`   ${p.toFixed(2)}      ${cell('bootstrap')} ${cell('wilson')} ${cell('cp')} ${cell('jackknife')} ${cell('bayes')}`)
}

console.log('\nLEGEND  cov (mean width)  ·  cov<0.95 = under-covers (too tight)  ·  high width with cov=1.00 = wasteful')

// ── Verdict ─────────────────────────────────────────────────────────
console.log('\nVERDICT')
console.log('  Drive the choice from coverage + width:')
console.log('  - Bootstrap can under-cover at small n (Edgeworth correction needed).')
console.log('  - Wilson is asymptotic but well-behaved for n>10.')
console.log('  - Clopper-Pearson guarantees ≥0.95 coverage by construction (often over-covers).')
console.log('  - Jackknife uses normal-CI on a small jackknife variance; can over- or under-cover.')
console.log('  - Bayes(1,1) gives a credible interval, not a frequentist CI; slightly different semantics.')
