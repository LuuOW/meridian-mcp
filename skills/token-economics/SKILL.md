---
name: token-economics
description: Model token usage as an energy budget — estimate workload cost, compare throughput per watt / per dollar, and choose routes, models, and architectures with the best signal-per-token ratio
keywords: ["token", "economics", "model", "usage", "energy", "budget", "estimate", "workload", "cost", "compare", "throughput", "watt", "dollar", "choose", "routes", "models"]
orb_class: trojan
---

# token-economics

Tokens are not only a billing unit. They are an operational energy budget.

In this system:

- tokens spent = energy consumed
- useful output = work extracted
- signal per token = efficiency
- throughput per watt / per dollar = system fitness

`token-awareness` asks "what is the minimum effective change?"

`token-economics` asks "what is the best return on energy for this workload?"

## 1) Core Questions

Before choosing an implementation path, model, or orchestration pattern, ask:

1. What is the expected token burn for this task?
2. How much of that burn produces useful signal instead of exploration noise?
3. Can the same outcome be achieved with fewer reads, fewer hops, or a smaller model?
4. What is the comparable performance per watt / per dollar across routes?

## 2) Energy Framing

Use these derived metrics:

```text
energy_cost          = total tokens consumed
useful_work          = accepted decisions, code changes, validated conclusions
energy_efficiency    = useful_work / energy_cost
throughput_per_watt  = useful_work / wall_time / watts
throughput_per_dollar = useful_work / dollar_cost
```

If real watt telemetry is unavailable, use tokens as the normalized energy unit.

That still enables valid comparisons:

- route A vs route B
- model A vs model B
- single-agent vs multi-agent
- broad read vs grep + targeted read

## 3) Comparison Template

```text
Option A: large-model, broad context read
- 12k input tokens
- 2 tool hops
- 1 answer
- low implementation risk

Option B: grep + targeted reads + smaller model
- 2.5k input tokens
- 4 tool hops
- 1 answer
- similar implementation risk

If output quality is comparable, B has much better energy efficiency.
```

## 4) What Usually Burns Energy

- broad exploratory reads without a concrete question
- repeated re-reading of the same files
- too many agent handoffs
- large-model use for narrow deterministic tasks
- verification that repeats the implementation worker's path instead of testing the result
- giant prompt blocks that carry stale context forward

## 5) What Usually Improves Efficiency

- grep before read
- route narrowing before spawning workers
- using high-luminance skills first
- retrieval of fragments instead of invoking whole overlapping skills
- compaction after major phase changes
- reserving the expensive model for synthesis, not every step

## 6) Model Selection Heuristic

```text
If the task is:
- deterministic lookup or shape-matching → cheapest capable model
- targeted implementation with clear files → medium model
- cross-domain synthesis / ambiguous planning → strongest model
```

Do not pay frontier-model energy for clerical routing.

## 7) Architecture Guidance

Prefer:

- narrow prompts
- low-drag routes
- explicit ownership
- reused patterns
- staged verification

Avoid:

- parallel workers that duplicate investigation
- full-repo summaries for local fixes
- "just in case" refactors
- context hoarding

## 8) Checklist

- [ ] Estimated token burn before starting
- [ ] Compared at least two plausible routes
- [ ] Chosen the route with the best signal-per-token ratio, not just the fanciest
- [ ] Avoided large-model use where a smaller model is sufficient
- [ ] Measured or estimated throughput per watt / per dollar when comparing options
- [ ] Escalated to a higher-energy route only when correctness, risk, or ambiguity justifies it
