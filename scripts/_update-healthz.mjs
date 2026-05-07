#!/usr/bin/env node
// Internal helper for the classifier-health workflow. Reads
// /tmp/eval.json (output of eval-against-public-data.mjs --json)
// and /tmp/model.json (output of GET /v1/model-info), writes
// landing/healthz.json. Kept as a real .mjs file rather than a
// heredoc inside the workflow so package.json's "type": "module"
// doesn't fight with stdin-as-CJS resolution.

import { readFileSync, writeFileSync } from 'node:fs'

const evalRes  = JSON.parse(readFileSync('/tmp/eval.json',  'utf8'))
const modelRes = JSON.parse(readFileSync('/tmp/model.json', 'utf8'))

const out = {
  ok: true,
  classifier: {
    recall_at_1:           evalRes.recall.v2.at_1,
    recall_at_5:           evalRes.recall.v2.at_5,
    recall_at_1_baseline:  evalRes.recall.trivial.at_1,
    recall_at_1_random:    evalRes.recall.random.at_1,
    dataset:               evalRes.dataset,
    n_eval:                evalRes.n_eval,
    evaluated_at:          evalRes.generated_at,
  },
  model: {
    version:    modelRes.version    || null,
    n_updates:  modelRes.n_updates  || 0,
    n_pairs:    modelRes.n_pairs    || 0,
    cold_start: modelRes.cold_start ?? true,
    updated_at: modelRes.updated_at || null,
  },
  built_at: new Date().toISOString(),
}

writeFileSync('landing/healthz.json', JSON.stringify(out, null, 2) + '\n')
console.log(`recall@1=${out.classifier.recall_at_1}  recall@5=${out.classifier.recall_at_5}  n_updates=${out.model.n_updates}`)
