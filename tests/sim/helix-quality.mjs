#!/usr/bin/env node
// Helix recommendation-quality simulation.
//
// Calls the live /v1/helix endpoint (mcp.ask-meridian.uk) with each
// injury in the gold set + the same 10-entry SEED_PROTEINS list the
// production client uses, then compares the worker-returned ranking
// against the curator-defined "correct" UniProts.
//
// Gold set was built by hand from the published `use` fields in
// helix/app.mjs SEED_PROTEINS:
//   - EGF (P01133): corneal abrasion, skin re-epithelialization
//   - KGF/FGF-7 (P21583): skin burn, mucositis
//   - bFGF/FGF-2 (P09038): skin wound, angiogenesis
//   - Lactoferrin (P02788): ocular dryness, antimicrobial
//   - Lubricin (Q6UWN8): corneal lubrication
//   - Insulin (P01308): corneal nerve regeneration
//   - aFGF/FGF-1 (P05230): wound healing, neural regeneration
//   - HGF (P14210): corneal endothelial regen
//   - IL-8 (P10145): NEGATIVE CONTROL — not therapeutic alone
//   - Alpha-2-M (P01023): protease inhibitor, anti-inflammatory
//
// Reports:
//   - per-injury: returned top-K, gold IDs in top-K, top-K precision
//   - aggregate: recall@{1,3,5}, precision@1, nDCG@5
//   - negative-control hit-rate: how often IL-8 (P10145) wrongly
//     surfaces in top-3 (should be 0% or near it).
//
// Re-runnable; uses the live LLM so output varies trial-to-trial.
// `--seed N` (default 1) seeds the run number so retries are tagged.
// Set `HELIX_SIM_TRIALS=N` to run multiple replicates per injury.

const ENDPOINT = process.env.HELIX_SIM_ENDPOINT || 'https://mcp.ask-meridian.uk/v1/helix'
const ORIGIN   = process.env.HELIX_SIM_ORIGIN   || 'https://meridian.ask-meridian.uk'
const TRIALS   = Math.max(1, parseInt(process.env.HELIX_SIM_TRIALS || '1', 10))
const TOP_K    = 5
// GH Models free tier rate-limits aggressively. 30s between calls gives
// the bucket time to refill. Override with HELIX_SIM_GAP_MS for tighter
// runs if you have a paid token in MERIDIAN_GITHUB_TOKEN.
const GAP_MS   = Math.max(0, parseInt(process.env.HELIX_SIM_GAP_MS || '30000', 10))

const SEED_PROTEINS = [
  { uniprot: 'P01133', pdb: '1JL9', name: 'EGF',         use: 'corneal abrasion, skin re-epithelialization', aa_len: 53,   notes: 'small, stable, FDA-approved as recombinant' },
  { uniprot: 'P21583', pdb: '1QQK', name: 'KGF/FGF-7',   use: 'skin burn, mucositis',                         aa_len: 194,  notes: 'palifermin is approved biologic' },
  { uniprot: 'P09038', pdb: '1BFF', name: 'bFGF/FGF-2',  use: 'skin wound, angiogenesis',                     aa_len: 288,  notes: 'trafermin is approved in Japan' },
  { uniprot: 'P02788', pdb: '1LFG', name: 'Lactoferrin', use: 'ocular dryness, antimicrobial',                aa_len: 710,  notes: 'OTC topical in some markets' },
  { uniprot: 'Q6UWN8', pdb: '4WTI', name: 'Lubricin',    use: 'corneal lubrication',                          aa_len: 1404, notes: 'recombinant in clinical trials for dry eye' },
  { uniprot: 'P01308', pdb: '3I40', name: 'Insulin',     use: 'corneal nerve regeneration (off-label)',       aa_len: 110,  notes: 'small, stable' },
  { uniprot: 'P05230', pdb: '1AFC', name: 'aFGF/FGF-1',  use: 'wound healing, neural regeneration',           aa_len: 155,  notes: 'recombinant in trials' },
  { uniprot: 'P14210', pdb: '1NK1', name: 'HGF',         use: 'corneal endothelial regen',                    aa_len: 728,  notes: 'large, delivery challenging' },
  { uniprot: 'P10145', pdb: '5D14', name: 'IL-8',        use: 'modulates neutrophil response — NOT therapeutic alone', aa_len: 99, notes: 'included as negative control' },
  { uniprot: 'P01023', pdb: '1BV8', name: 'Alpha-2-M',   use: 'protease inhibitor, anti-inflammatory',        aa_len: 1474, notes: 'large; topical delivery hard' },
]

// Negative control: should NEVER appear in top-3 for any therapeutic ask.
const NEGATIVE_CONTROL = 'P10145'

// Gold set: each entry maps an injury description to an ordered list
// of "correct" UniProts (most-relevant first). The system gets credit
// when its top-K contains these IDs; nDCG weights earlier positions
// more heavily.
const GOLD = [
  { injury: 'Deep corneal abrasion with photophobia after a foreign body strike',
    gold: ['P01133', 'P05230', 'P01308'] },
  { injury: 'Second-degree skin burn on the forearm, partial thickness',
    gold: ['P21583', 'P09038'] },
  { injury: 'Chronic dry eye disease with stinging and inflammation',
    gold: ['P02788', 'Q6UWN8'] },
  { injury: 'Oral mucositis after chemotherapy',
    gold: ['P21583'] },
  { injury: 'Diabetic foot ulcer with slow granulation',
    gold: ['P09038', 'P05230', 'P01133'] },
  { injury: 'Corneal endothelial cell loss after intraocular surgery',
    gold: ['P14210'] },
  { injury: 'Corneal nerve density reduction after LASIK',
    gold: ['P01308'] },
  { injury: 'Surface skin abrasion needing rapid re-epithelialization',
    gold: ['P01133', 'P09038'] },
  { injury: 'Bacterial conjunctivitis with mucopurulent discharge',
    gold: ['P02788'] },
  { injury: 'Protease over-activity blocking healing in a chronic wound bed',
    gold: ['P01023'] },
  { injury: "Sjögren's-related ocular surface dryness with goblet-cell loss",
    gold: ['P02788', 'Q6UWN8'] },
  { injury: 'Peripheral nerve transection — promote axonal regeneration',
    gold: ['P05230'] },
  { injury: 'Severe ocular surface chemical trauma',
    gold: ['P01133', 'P01308'] },
  { injury: 'Burn-induced dermal fibrosis prevention',
    gold: ['P21583', 'P09038'] },
  { injury: 'Wound bed angiogenesis stimulation in a thick laceration',
    gold: ['P09038', 'P05230'] },
  { injury: 'Lacrimal gland dysfunction with persistent ocular dryness',
    gold: ['P02788', 'Q6UWN8'] },
  { injury: 'Recurrent corneal erosion syndrome',
    gold: ['P01133', 'Q6UWN8'] },
  { injury: 'Neutrophil-driven chronic inflammation needing protease control',
    gold: ['P01023'] },
  { injury: 'Mild dry eye complaints in a contact-lens wearer',
    gold: ['Q6UWN8', 'P02788'] },
]

function dcg(relevances) {
  let s = 0
  for (let i = 0; i < relevances.length; i++) {
    s += relevances[i] / Math.log2(i + 2)  // i+2 since DCG uses 1-indexed log2(i+1) starting at i=1
  }
  return s
}

function ndcgAt(predicted, gold, k) {
  // relevance: 1 if predicted[i] is in gold, weighted by rank in gold (higher = more relevant)
  const goldSet = new Set(gold)
  const rels = predicted.slice(0, k).map(id => {
    const idx = gold.indexOf(id)
    return idx >= 0 ? (gold.length - idx) : 0
  })
  const idealRels = gold.slice(0, k).map((_, i) => gold.length - i)
  const idcg = dcg(idealRels)
  if (idcg === 0) return 0
  return dcg(rels) / idcg
}

function recallAt(predicted, gold, k) {
  const top = new Set(predicted.slice(0, k))
  const hits = gold.filter(g => top.has(g)).length
  return gold.length ? hits / gold.length : 0
}

function precisionAt(predicted, gold, k) {
  const top = predicted.slice(0, k)
  const hits = top.filter(p => gold.includes(p)).length
  return top.length ? hits / top.length : 0
}

async function callHelix(injury) {
  // GH Models free tier rate-limits at ~10 req/min — retry on 429 with
  // exponential backoff. First call after a long pause usually 200s; the
  // backoff catches the 4-call burst before the limiter has caught up.
  const t0 = Date.now()
  let attempt = 0
  while (true) {
    attempt++
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ injury_description: injury, candidates: SEED_PROTEINS, limit: TOP_K }),
    })
    const ms = Date.now() - t0
    const j  = await res.json().catch(() => ({}))
    if (res.ok) {
      const ranked = (j.candidates || []).map(c => c.uniprot || c.slug).filter(Boolean)
      return { ranked, ms, raw: j }
    }
    // 429 from the GH Models upstream surfaces as a 502 with the
    // upstream HTTP code in the message. Catch both shapes.
    const isRate = res.status === 429 || (j?.error || '').includes('429')
    if (isRate && attempt <= 3) {
      const backoff = 12_000 * attempt  // 12s, 24s, 36s
      console.error(`    [rate-limited, backing off ${backoff/1000}s — attempt ${attempt}]`)
      await new Promise(r => setTimeout(r, backoff))
      continue
    }
    throw new Error(`HTTP ${res.status}: ${j.error || ''}`)
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  console.log('\n=========================================================')
  console.log(' Helix recommendation-quality simulation')
  console.log(` endpoint: ${ENDPOINT}`)
  console.log(` trials per injury: ${TRIALS}`)
  console.log(` gold-set size: ${GOLD.length} injuries`)
  console.log('=========================================================\n')

  const rows = []
  let totalCalls = 0, failedCalls = 0, totalMs = 0

  for (let gi = 0; gi < GOLD.length; gi++) {
    const { injury, gold } = GOLD[gi]
    // Throttle between injuries — 7s gap keeps us under the ~10 req/min
    // GH Models limit even after a few back-to-back successes.
    if (gi > 0) await sleep(GAP_MS)
    let trialRows = []
    for (let t = 0; t < TRIALS; t++) {
      try {
        totalCalls++
        const { ranked, ms } = await callHelix(injury)
        totalMs += ms
        trialRows.push({
          injury,
          gold,
          ranked,
          ms,
          ndcg5: ndcgAt(ranked, gold, 5),
          r1: recallAt(ranked, gold, 1),
          r3: recallAt(ranked, gold, 3),
          r5: recallAt(ranked, gold, 5),
          p1: precisionAt(ranked, gold, 1),
          neg_in_top3: ranked.slice(0, 3).includes(NEGATIVE_CONTROL) ? 1 : 0,
        })
      } catch (e) {
        failedCalls++
        console.error(`  ✗ ${injury.slice(0, 60)}… — ${e.message}`)
      }
    }
    // Average per-injury metrics across trials.
    if (trialRows.length) {
      const avg = k => trialRows.reduce((s, r) => s + r[k], 0) / trialRows.length
      const summary = {
        injury,
        gold,
        ranked_first: trialRows[0].ranked,  // sample from first trial for display
        ms:    avg('ms'),
        ndcg5: avg('ndcg5'),
        r1:    avg('r1'),
        r3:    avg('r3'),
        r5:    avg('r5'),
        p1:    avg('p1'),
        neg:   avg('neg_in_top3'),
      }
      rows.push(summary)
      const goldDisp   = gold.join(',')
      const rankedDisp = summary.ranked_first.slice(0, 5).join(',')
      const hit3 = gold.some(g => summary.ranked_first.slice(0, 3).includes(g)) ? '✓' : '✗'
      console.log(`  ${hit3} nDCG@5=${summary.ndcg5.toFixed(2)}  r@1=${summary.r1.toFixed(2)} r@3=${summary.r3.toFixed(2)} r@5=${summary.r5.toFixed(2)}  ${summary.ms|0}ms`)
      console.log(`    "${injury.slice(0, 70)}${injury.length > 70 ? '…' : ''}"`)
      console.log(`    gold=[${goldDisp}]  ranked=[${rankedDisp}]`)
    }
  }

  if (!rows.length) {
    console.log('\n  no successful calls — check endpoint availability or auth.\n')
    process.exit(1)
  }

  const avg = k => rows.reduce((s, r) => s + r[k], 0) / rows.length
  console.log('\n=========================================================')
  console.log(` aggregate over ${rows.length} injuries  (${TRIALS} trials each)`)
  console.log('=========================================================')
  console.log(`  nDCG@5         = ${avg('ndcg5').toFixed(3)}`)
  console.log(`  recall@1       = ${avg('r1').toFixed(3)}`)
  console.log(`  recall@3       = ${avg('r3').toFixed(3)}`)
  console.log(`  recall@5       = ${avg('r5').toFixed(3)}`)
  console.log(`  precision@1    = ${avg('p1').toFixed(3)}`)
  console.log(`  IL-8 in top-3  = ${avg('neg').toFixed(3)}  (negative control, ideal=0)`)
  console.log(`  mean latency   = ${(totalMs / Math.max(1, totalCalls - failedCalls)) | 0} ms`)
  console.log(`  calls          = ${totalCalls - failedCalls} ok / ${failedCalls} failed`)
  console.log('=========================================================\n')
}

main().catch(e => { console.error(e); process.exit(1) })
