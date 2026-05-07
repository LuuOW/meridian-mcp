// Shared synthetic-skill panel used by:
//   • scripts/calibrate-classifier.mjs  (current-classifier baseline)
//   • scripts/simulate-classifier-v2.mjs (dry run of proposed changes)
//
// 18 skills covering every (class × star-system) combination at
// realistic body lengths and keyword counts. The labels
// (__expectedClass, __expectedSystem, __relevant) are stripped before
// classification — they're only used for the class-accuracy and
// recall metrics.

// ── Synthetic panel ─────────────────────────────────────────────────
// 18 skills covering every (class × system) combination at realistic
// body lengths. Labels (`__expectedClass`, `__expectedSystem`,
// `__relevant`) are stripped before classification — they're only used
// for the recall metric.
const PANEL = [
  // ── PLANETS (high mass × scope × independence; domain anchors) ─────
  {
    slug: 'agentic-eval-harness',
    description: 'End-to-end evaluation harness for LLM agents — task definitions, judge models, grading rubrics, dataset versioning.',
    keywords: ['evaluation', 'llm-agents', 'benchmark', 'judge-models', 'grading', 'dataset', 'reproducibility'],
    body: '## Use It For\n- Building public benchmarks for LLM-agent capabilities you can publish on HuggingFace.\n- Comparing routing strategies, tool-selection accuracy, or task-completion rates across models.\n- Producing model-card-ready metrics that survive peer review.\n\n## Workflow\n1. Curate a labelled task→answer dataset across diverse domains.\n2. Define one or more judge models with explicit grading rubrics.\n3. Run candidates through the harness in matrix configurations.\n4. Compute aggregate scores plus per-task breakdown.\n5. Publish dataset, code, and a write-up so external teams can reproduce.\n\n## Pitfalls\n- LLM-judged evals against LLM-generated ground truth are circular.\n- Single-judge results are easily dismissed; use cross-judge matrices.\n- Tasks scraped without labelling produce noisy benchmarks.',
    __expectedClass: 'planet',
    __expectedSystem: 'mind',
    __relevant: true,
  },
  {
    slug: 'distributed-task-queue',
    description: 'Production task-queue infrastructure for asynchronous workloads with retry, dead-letter, and observability.',
    keywords: ['queue', 'distributed', 'workers', 'redis', 'kafka', 'retry', 'dead-letter', 'observability'],
    body: '## Use It For\n- Decoupling user-facing requests from long-running jobs (image processing, ML inference, batch ETL).\n- Surviving worker crashes without losing work; retrying transient failures with exponential backoff.\n- Operating queues at scale with end-to-end visibility into latency, throughput, and failure modes.\n\n## Workflow\n1. Pick a broker (Redis Streams, Kafka, RabbitMQ) based on durability and throughput needs.\n2. Define job schemas with explicit versioning.\n3. Write idempotent workers; handle partial failure deterministically.\n4. Wire DLQ + alerting on stuck jobs.\n5. Instrument: queue depth, worker lag, retry rate, p99 latency.\n\n## Pitfalls\n- Workers without idempotency handle retries badly.\n- Unbounded queues mask upstream failure for hours.\n- Forgetting to ACK after success leaves jobs in flight forever.',
    __expectedClass: 'planet',
    __expectedSystem: 'forge',
    __relevant: false,
  },
  {
    slug: 'growth-experiment-stack',
    description: 'Full-funnel growth experimentation — A/B testing, attribution modelling, lifecycle email, paid acquisition feedback loop.',
    keywords: ['ab-testing', 'attribution', 'funnel', 'cohort', 'lifecycle', 'email', 'paid-acquisition', 'retention'],
    body: '## Use It For\n- Running statistically valid product experiments without rolling your own infra.\n- Closing the loop from paid acquisition → activation → retention with attribution that survives iOS privacy changes.\n- Turning anecdotal "users want X" into measurable "shipping X moves cohort retention by Y%".\n\n## Workflow\n1. Instrument the funnel end-to-end with a single event taxonomy.\n2. Set primary + guardrail metrics before launching any experiment.\n3. Use sequential testing where you can\'t pre-commit to sample size.\n4. Build cohort retention curves, not just snapshot conversion rates.\n5. Feed experiment outcomes back into ad-creative + email triggers.\n\n## Pitfalls\n- Peeking at A/B results before reaching power inflates false positives.\n- Attribution models that double-count touches across channels.\n- Lifecycle emails sent without holdouts make ROI unmeasurable.',
    __expectedClass: 'planet',
    __expectedSystem: 'signal',
    __relevant: false,
  },
  // ── MOONS (low independence, parent dependence) ─────────────────────
  {
    slug: 'eval-result-cache',
    description: 'Lightweight cache satellites the eval harness — local store of completed runs keyed by config hash.',
    keywords: ['cache', 'eval', 'hash', 'storage', 'local'],
    body: '## Use It For\n- Avoiding re-running a 30-minute eval matrix when only the analysis code changed.\n- Sharing cached runs across teammates via a shared bucket or local mirror.\n\n## Workflow\n1. Hash the eval config (model + dataset + prompt + judge).\n2. Write completed results keyed by hash; reuse on cache hit.\n3. Invalidate when the harness version bumps.\n\n## Pitfalls\n- Cache hits on a stale judge model produce silently outdated results.',
    __expectedClass: 'moon',
    __expectedSystem: 'mind',
    __relevant: false,
  },
  {
    slug: 'queue-job-mirror',
    description: 'Read-only mirror of the task queue for analytics — same shape, different storage.',
    keywords: ['mirror', 'queue', 'analytics', 'read-replica'],
    body: '## Use It For\n- Querying queue history without taxing the production broker.\n- Building dashboards on job throughput.\n\n## Workflow\n1. Stream completed jobs into an analytics store.\n2. Match the production broker\'s schema.\n\n## Pitfalls\n- Schema drift between primary and mirror breaks reports.',
    __expectedClass: 'moon',
    __expectedSystem: 'forge',
    __relevant: false,
  },
  {
    slug: 'experiment-event-buffer',
    description: 'In-memory buffer that satellites the experiment stack — short retention, very fast reads.',
    keywords: ['buffer', 'events', 'experiment', 'memory'],
    body: '## Use It For\n- Smoothing event-burst spikes during launch days.\n- Powering live experiment dashboards.\n\n## Workflow\n1. Sit between the producer and the warehouse.\n2. Drop oldest on overflow, never block the producer.\n\n## Pitfalls\n- Buffer overruns silently lose data.',
    __expectedClass: 'moon',
    __expectedSystem: 'signal',
    __relevant: false,
  },
  // ── TROJANS (companion at L4/L5; high dep_ratio; low fragmentation) ─
  {
    slug: 'eval-judge-rubric',
    description: 'Companion grading rubric pinned to the eval harness — co-activates whenever the harness loads.',
    keywords: ['rubric', 'grading', 'eval', 'judge', 'criteria', 'evaluation'],
    body: '## Use It For\n- Producing the same scoring criteria across every judge invocation.\n- Locking the harness and the rubric into one versioned artefact.\n\n## Workflow\n1. Co-version the rubric with the harness.\n2. Load both together so a deploy can\'t ship them out of sync.\n3. Surface the rubric in every grading prompt verbatim.\n\n## Pitfalls\n- Rubrics that drift from the harness produce uncomparable runs.',
    __expectedClass: 'trojan',
    __expectedSystem: 'mind',
    __relevant: true,
  },
  {
    slug: 'queue-config-companion',
    description: 'Configuration companion to the distributed task queue — co-activates with the queue, defines retry policies.',
    keywords: ['config', 'queue', 'retry', 'policy', 'companion', 'distributed'],
    body: '## Use It For\n- Defining retry budgets, backoff curves, dead-letter rules in lockstep with the queue itself.\n- Moving in lockstep with the queue across deploys.\n\n## Workflow\n1. Treat the config as part of the queue\'s release artefact, not an external dependency.\n2. Roll forward and roll back together.\n\n## Pitfalls\n- Hot-reloading config without restarting workers leads to mixed-policy traffic.',
    __expectedClass: 'trojan',
    __expectedSystem: 'forge',
    __relevant: false,
  },
  {
    slug: 'experiment-cohort-tagger',
    description: 'L4 companion to the growth experiment stack — co-activates to tag every event with cohort identity.',
    keywords: ['cohort', 'experiment', 'tagging', 'companion', 'growth', 'analytics'],
    body: '## Use It For\n- Tagging every product event with the cohort identity used in the experiment\'s analysis.\n- Locking the cohort definition to the experiment\'s reporting code.\n\n## Workflow\n1. Pull cohort definitions from the experiment stack at boot.\n2. Inject cohort id into every event payload.\n3. Roll cohorts forward only when the experiment closes.\n\n## Pitfalls\n- Mid-experiment cohort changes break analysis.',
    __expectedClass: 'trojan',
    __expectedSystem: 'signal',
    __relevant: false,
  },
  // ── ASTEROIDS (low mass, narrow scope, independent niche tools) ─────
  {
    slug: 'json-pretty-print',
    description: 'Tiny CLI that pretty-prints JSON with stable key ordering.',
    keywords: ['json', 'cli', 'format', 'pretty-print'],
    body: '## Use It For\n- Diffing two JSON payloads where key order matters.\n- Inspecting API responses on the terminal.\n\n## Workflow\n1. Pipe stdin → CLI → stdout.\n\n## Pitfalls\n- Streaming very large files into memory.',
    __expectedClass: 'asteroid',
    __expectedSystem: 'forge',
    __relevant: false,
  },
  {
    slug: 'subject-line-tester',
    description: 'Quick tool to A/B-test email subject lines with bandit-style allocation.',
    keywords: ['subject-line', 'email', 'bandit', 'ab-test'],
    body: '## Use It For\n- Picking a subject line for a one-off broadcast without standing up a full experiment.\n- Bandit allocation when you only have hours to converge.\n\n## Workflow\n1. Define 4–8 candidate subject lines.\n2. Allocate Thompson-sampled traffic.\n3. Lock in the winner once one variant dominates.\n\n## Pitfalls\n- Too few opens to converge before the broadcast goes out.',
    __expectedClass: 'asteroid',
    __expectedSystem: 'signal',
    __relevant: false,
  },
  {
    slug: 'embedding-cosine-debug',
    description: 'Inspector for embedding cosine similarities — sanity-checks embedding-based retrieval.',
    keywords: ['embedding', 'cosine', 'debug', 'similarity', 'retrieval'],
    body: '## Use It For\n- Confirming a retrieval miss is a real semantic miss vs an indexing bug.\n- Eyeballing whether two phrases really are close in your embedding space.\n\n## Workflow\n1. Pass two strings + an embedding model.\n2. Get cosine + nearest-neighbour list.\n\n## Pitfalls\n- Different embedding versions produce uncomparable cosines.',
    __expectedClass: 'asteroid',
    __expectedSystem: 'mind',
    __relevant: false,
  },
  // ── COMETS (high drag × cross_domain, low dep_ratio) ────────────────
  {
    slug: 'cross-language-fallback-router',
    description: 'High-eccentricity router for rare-language coverage — sweeps through long-tail languages once per cycle.',
    keywords: ['language', 'rare', 'fallback', 'router', 'long-tail', 'multilingual', 'translation', 'cross-domain'],
    body: '## Use It For\n- Adding coverage for languages where you do not have first-class support.\n- Triggering a fallback path that does best-effort translation + reasoning.\n\n## Workflow\n1. Detect language at request time.\n2. If language is in the unsupported set, pivot to the fallback router.\n3. Translate, run the supported pipeline, translate back.\n\n## Pitfalls\n- Translation errors compound silently across the pivot.\n- Latency spikes when fallback path is hit.',
    __expectedClass: 'comet',
    __expectedSystem: 'signal',
    __relevant: false,
  },
  {
    slug: 'rare-arch-image-builder',
    description: 'Long-period image builder for non-x86 architectures — only triggered when an ARM64 / RISC-V build is needed.',
    keywords: ['build', 'arm64', 'risc-v', 'cross-compile', 'docker', 'rare', 'architecture'],
    body: '## Use It For\n- Producing images for architectures the main CI pipeline does not support.\n- Cross-compilation that is too slow to run on every PR.\n\n## Workflow\n1. Match a label or a tag to trigger the slow path.\n2. Cross-compile + cache aggressively.\n3. Push to a separate registry so it does not pollute the fast lane.\n\n## Pitfalls\n- Cache invalidation is the main cost driver here.',
    __expectedClass: 'comet',
    __expectedSystem: 'forge',
    __relevant: false,
  },
  {
    slug: 'edge-case-prompt-collector',
    description: 'Gathers rare prompt failure modes that span multiple model families — fires only on out-of-distribution inputs.',
    keywords: ['prompts', 'edge-cases', 'failures', 'collector', 'cross-model'],
    body: '## Use It For\n- Building a regression set of prompts that have ever broken any model in the fleet.\n- Surfacing the long tail of failure modes for a research write-up.\n\n## Workflow\n1. Hook into model serving to capture flagged outputs.\n2. Cluster across model families to find shared failure patterns.\n3. Promote into a regression set when a pattern reproduces.\n\n## Pitfalls\n- The set bloats fast; tier by reproduction frequency.',
    __expectedClass: 'comet',
    __expectedSystem: 'mind',
    __relevant: false,
  },
  // ── IRREGULARS (high cross_domain × fragmentation; cross-system bridge)
  {
    slug: 'forge-mind-bridge',
    description: 'Cross-domain bridge between deployment infra and ML-research workflows — out-of-plane, retrograde, fragmented.',
    keywords: ['deployment', 'research', 'mlops', 'cross-domain', 'bridge', 'experiment-tracking', 'observability', 'reproducibility'],
    body: '## Use It For\n- Plumbing experiment-tracking metadata from research notebooks into production deploy artefacts.\n- Closing the loop from a research model checkpoint to a deployed inference path with full provenance.\n- Producing reproducibility evidence when a deployed model misbehaves and someone has to find which experiment it came from.\n\n## Workflow\n1. Tag every experiment run with the deploy artefact hash that consumes it.\n2. Mirror experiment metadata into the deployment registry.\n3. Reverse-link incidents back to the experiment that produced the failing checkpoint.\n\n## Pitfalls\n- Researchers do not want extra metadata steps; automate or it does not happen.\n- Production deploys lose provenance fast without a forcing function.',
    __expectedClass: 'irregular',
    __expectedSystem: 'forge',
    __relevant: false,
  },
  {
    slug: 'signal-mind-translator',
    description: 'Cross-domain bridge between growth metrics and model-quality metrics — surfaces when product KPIs depend on ML.',
    keywords: ['growth', 'ml-metrics', 'kpis', 'translation', 'cross-domain', 'attribution', 'evaluation'],
    body: '## Use It For\n- Showing growth teams which model regressions actually hurt the funnel.\n- Showing ML teams which user-facing metrics they should optimise jointly with offline metrics.\n- Resolving arguments about which loss function predicts retention.\n\n## Workflow\n1. Pair offline ML metrics with the funnel step they affect.\n2. Run paired A/B + offline-eval comparisons over time.\n3. Promote the offline metric that correlates best to the team\'s scorecard.\n\n## Pitfalls\n- Correlations across small experiment counts mislead.',
    __expectedClass: 'irregular',
    __expectedSystem: 'signal',
    __relevant: false,
  },
  {
    slug: 'forge-signal-incident-router',
    description: 'Bridge between infrastructure incidents and growth-comms playbooks — fragmented, cross-domain, irregular.',
    keywords: ['incidents', 'comms', 'status', 'cross-domain', 'growth', 'reliability', 'transparency'],
    body: '## Use It For\n- Triggering customer-facing comms automatically when SRE pages on a user-impacting incident.\n- Reconciling SRE ground truth with what marketing is saying on status pages.\n- Producing post-incident notes that tie revenue impact to root cause.\n\n## Workflow\n1. Listen on the incident channel.\n2. Map severity to a comms tier; auto-draft customer email + status update.\n3. Require SRE sign-off before send.\n\n## Pitfalls\n- Fully automatic comms can fire on false-positive incidents and amplify them.',
    __expectedClass: 'irregular',
    __expectedSystem: 'forge',
    __relevant: false,
  },
]

export { PANEL }

export const TASK = 'design a public benchmark for tool-routing failures in LLM agents'

// Strip __expected* labels; the panel is fed to orbitalClassify via
// this helper so production-shaped objects go through the pipeline.
export function panelForClassify() {
  return PANEL.map(({ __expectedClass, __expectedSystem, __relevant, ...skill }) => skill)
}
