---
name: mlops
description: MLOps infrastructure engineering covering model serving (vLLM, TorchServe, Triton), feature stores, model registries (MLflow, W&B), A/B and shadow deployments, drift detection, Prometheus/Grafana ML metrics, Kubeflow Pipelines, and Airflow DAGs for end-to-end training and deployment pipelines.
orb_class: asteroid_belt
keywords: ["mlops", "vllm", "torchserve", "triton", "mlflow", "wandb", "feature-store", "model-registry", "drift-detection", "kubeflow", "airflow", "canary-rollout", "shadow-deployment", "ab-testing", "prometheus", "grafana", "feast", "tecton", "bentoml", "seldon"]
---

# MLOps

MLOps is the discipline of applying DevOps principles to the full machine-learning lifecycle: data ingestion, feature engineering, training, evaluation, serving, monitoring, and retraining. This skill covers the infrastructure layer — the plumbing that keeps models reliable in production — not model architecture or research. Expect opinionated guidance on versioning, deployment strategies, observability, and the operational patterns that separate proof-of-concept from production systems.

## Core Concepts

### Model Serving

**vLLM** is the dominant LLM inference server. Key knobs: `--tensor-parallel-size` (split across GPUs), `--gpu-memory-utilization` (default 0.9, lower if OOM during prefill), `--max-model-len` (cap KV-cache footprint). PagedAttention means KV cache is allocated in non-contiguous blocks — profiling with `--disable-log-stats=false` exposes scheduler queue depth. For multi-LoRA serving use `--enable-lora` with `--max-loras` and load adapters via the `/v1/load_lora_adapter` endpoint without restarting.

**Triton Inference Server** uses an `ensemble` model type to chain pre/post-processing with inference in a single request. Each model directory needs a `config.pbtxt`. Dynamic batching: set `max_queue_delay_microseconds` and `preferred_batch_size`. Use the ONNX backend for portability; TensorRT backend for latency-critical paths. Monitor `nv_inference_queue_duration_us` and `nv_inference_exec_count` in Prometheus.

**TorchServe** handler pattern: subclass `BaseHandler`, override `preprocess`, `inference`, `postprocess`. Register with `torch-model-archiver --model-name foo --version 1.0 --serialized-file model.pt --handler handler.py`. Management API on `:8081`, inference on `:8080`. Scale workers per model: `PUT /models/foo?min_worker=2&max_worker=8`.

**BentoML** is useful when you want a Python-native abstraction over multiple backends. `@bentoml.service` + `@bentoml.api` decorators; deploy to BentoCloud or export as OCI image.

### Feature Stores

**Feast** is the open-source standard. Core objects: `FeatureView` (maps a data source to feature columns + TTL), `Entity` (join key), `FeatureService` (logical grouping for training/serving consistency). Online store (Redis, DynamoDB) for low-latency retrieval; offline store (BigQuery, Snowflake, Parquet) for training. Materialize with `feast materialize-incremental $(date -u +"%Y-%m-%dT%H:%M:%S")`. Point-in-time correct joins via `get_historical_features` prevent label leakage.

**Tecton** is the managed alternative — adds transformation compute (Spark/Raft), stream ingest, and SLA monitoring out of the box.

Feature versioning gotcha: changing a feature definition without bumping the version silently breaks reproducibility. Always version `FeatureView` objects; store the feature service snapshot hash alongside model artifacts in the registry.

### Model Registries

**MLflow** Model Registry stages: `None → Staging → Production → Archived`. Tag models with `mlflow.set_tag("git_sha", ...)` and log params/metrics/artifacts atomically inside `with mlflow.start_run()`. Use `mlflow.pyfunc.log_model` with a custom `python_function` flavor when the model isn't a standard framework — gives you a single `.predict(df)` interface everywhere. REST API: `GET /api/2.0/mlflow/registered-models/get-latest-versions` for CI promotion gates.

**Weights & Biases** Registry: link artifact versions with `run.link_artifact(artifact, target_path="registry/model-name:production")`. W&B Sweeps for hyperparameter search use Bayesian optimization by default; define `method: bayes` with `metric.goal: minimize` in the sweep config YAML. Artifact lineage graph tracks dataset → training run → model → serving endpoint automatically.

### Deployment Strategies

**Canary rollout**: route N% of traffic to new model, compare metrics for a soak period, then promote or rollback. In Kubernetes with Istio: `VirtualService` with weighted `destination` rules. In Seldon: `SeldonDeployment` with `traffic` split on `predictors`. Key metric: KL divergence between old and new output distributions, not just accuracy.

**Shadow deployment** (dark launch): clone 100% of production traffic to the challenger model, log outputs, never return them to the user. Implement with a sidecar that duplicates requests or an Envoy `mirror` filter: `request_mirror_policy: cluster: shadow-cluster, runtime_fraction: {numerator: 100}`. Compare offline; no user impact.

**A/B testing**: requires randomization unit (user ID, session ID), minimum detectable effect calculation before launch, and a statistical test appropriate for the metric (t-test for means, Mann-Whitney for non-normal, chi-squared for conversion rates). CUPED (see causal-inference skill) can cut required sample size by 30-60% using pre-experiment covariates.

### Drift Detection

**Data drift**: compare serving feature distributions to training distributions using Population Stability Index (PSI) or Kolmogorov-Smirnov test. PSI > 0.2 = significant drift. Evidently AI and Nannyml are the go-to libraries; integrate as Airflow sensors that fail a DAG if PSI threshold is breached.

**Concept drift**: the input distribution is stable but the relationship between features and target has changed. Detected via performance degradation (requires labels — often delayed). Use ADWIN or Page-Hinkley online change-detection algorithms when you have a streaming label signal.

**Model output drift**: monitor prediction distribution shift without ground truth. Useful leading indicator. Track with Prometheus histogram buckets on score quantiles; alert if p50/p95 shift > threshold.

### Prometheus / Grafana ML Metrics

Instrument serving containers with `prometheus_client`. Key metrics to expose:
- `model_inference_latency_seconds` (histogram, label: `model_version`)
- `model_prediction_score` (histogram, label: `model_name`) — for output drift detection
- `feature_freshness_seconds` (gauge, label: `feature_name`)
- `model_error_total` (counter, label: `error_type`)

Grafana dashboard pattern: use `histogram_quantile(0.99, rate(model_inference_latency_seconds_bucket[5m]))` for p99 latency. Alert on `increase(model_error_total[5m]) > 10` and on missing scrape targets via `up == 0`.

### Kubeflow Pipelines

Define pipelines with the KFP SDK v2 (`kfp.dsl`). Components are containerized functions decorated with `@dsl.component(base_image=..., packages_to_install=[...])`. Pass artifacts via `Output[Dataset]`, `Output[Model]` typed parameters — KFP handles URI injection. Pipeline-level caching: set `dsl.pipeline(enable_caching=True)`; step-level override with `task.set_caching_options(False)`. Use `dsl.Condition` for branching (e.g., only deploy if eval metric > threshold). Compile to YAML with `compiler.Compiler().compile(pipeline_func, 'pipeline.yaml')`.

### Airflow DAGs for Training Pipelines

Use `KubernetesPodOperator` for GPU training tasks — avoids Airflow worker resource contention. Pass model registry URIs via XCom (keep XComs small — only metadata, not tensors). `ExternalTaskSensor` for cross-DAG dependencies (e.g., feature materialization DAG must complete before training DAG starts). Use `params` + `trigger_dagrun` for parameterized retraining triggered by drift alerts. Set `on_failure_callback` to post to PagerDuty/Slack and tag the MLflow run as failed for traceability.

Gotcha: Airflow retries will re-run training tasks, which can waste GPU hours. Use `retries=0` on expensive compute tasks and `retries=3` only on lightweight I/O tasks like data validation sensors.
