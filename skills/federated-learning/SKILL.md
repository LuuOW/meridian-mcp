---
name: federated-learning
description: Federated learning engineering covering FedAvg and FedProx aggregation, differential privacy (DP-SGD, Opacus), secure aggregation protocols, PySyft, the Flower framework, split learning, on-device training, communication compression, non-IID data heterogeneity, and model poisoning defenses for privacy-preserving distributed ML.
orb_class: irregular_satellite
keywords: ["federated-learning", "fedavg", "fedprox", "differential-privacy", "dp-sgd", "opacus", "secure-aggregation", "pysyft", "flower", "flwr", "split-learning", "on-device-training", "communication-compression", "non-iid", "model-poisoning", "byzantine-fault-tolerance", "privacy-preserving-ml", "gradient-compression", "knowledge-distillation", "personalized-federated-learning"]
---

# Federated Learning

Federated learning (FL) trains machine learning models across decentralized data sources without centralizing raw data — devices or silos compute local updates, and only model parameters (gradients or weights) are aggregated by a coordinator. This skill covers the algorithmic foundations (aggregation strategies, privacy guarantees, communication efficiency), the production frameworks (Flower, PySyft), and the threat models (poisoning, inference attacks) that determine whether a FL deployment is actually privacy-preserving or merely privacy-theater.

## Core Concepts

### FedAvg and Its Variants

**FedAvg** (McMahan et al. 2017) is the canonical aggregation algorithm. Each round: (1) server samples K clients from N total; (2) each selected client downloads the global model, runs E epochs of SGD on its local data, uploads the updated weights; (3) server computes a weighted average of updates, weights proportional to local dataset size.

```python
# Server-side aggregation (simplified)
def fedavg_aggregate(client_updates):
    total_samples = sum(n for _, n in client_updates)
    aggregated = {}
    for params, n_samples in client_updates:
        weight = n_samples / total_samples
        for key, val in params.items():
            aggregated[key] = aggregated.get(key, 0) + weight * val
    return aggregated
```

Hyperparameters: `C` (client fraction per round, 0.1 is typical for large deployments), `E` (local epochs, 1-5), `B` (local batch size). High E causes **client drift** — local models overfit to local data and diverge from each other, making aggregation less effective. This is the core challenge of non-IID data.

**FedProx** adds a proximal term to the local objective to limit drift: minimize `F_k(w) + (μ/2)||w - w_global||²`. The μ parameter (0.001–1.0) controls how close local updates stay to the global model. FedProx degenerates to FedAvg when μ=0. Critical for heterogeneous (non-IID) settings.

**SCAFFOLD** uses control variates to correct client drift without restricting local optimization. Two extra vectors per client (c_i, c) correct the gradient direction. Better convergence than FedProx theoretically but doubles communication cost (send c_i update each round).

**FedNova** normalizes local updates by the number of local steps before aggregation, correcting for clients that perform different numbers of SGD steps (e.g., due to varying dataset sizes or dropped rounds).

**MOON (Model-Contrastive Federated Learning)** uses contrastive loss to align local representation learning with the global model: penalize similarity between current local representation and previous local representation, reward similarity with global model representation.

### Differential Privacy

Differential privacy provides a mathematical guarantee that the trained model reveals minimal information about any individual training sample. The core mechanism: add calibrated Gaussian or Laplace noise to gradients before aggregation.

**DP-SGD** (Abadi et al. 2016): per-example gradient clipping followed by noise addition.

```python
# Conceptual DP-SGD step
def dp_sgd_step(model, batch, clip_norm, noise_multiplier, lr):
    per_sample_grads = compute_per_sample_gradients(model, batch)
    # Clip each sample's gradient to L2 norm ≤ clip_norm
    norms = [g.norm() for g in per_sample_grads]
    clipped = [g / max(1, norm / clip_norm) for g, norm in zip(per_sample_grads, norms)]
    # Aggregate and add Gaussian noise
    avg_grad = sum(clipped) / len(batch)
    noise = torch.randn_like(avg_grad) * noise_multiplier * clip_norm / len(batch)
    noisy_grad = avg_grad + noise
    # Apply gradient update
    update_model(model, noisy_grad, lr)
```

The privacy cost is tracked via the **privacy accountant** (Rényi DP or GDP). After T steps: `ε = accountant.get_epsilon(delta=1e-5)`. The key insight: `noise_multiplier` (σ/C) is the primary knob — higher multiplier = stronger privacy = worse utility. Typical production settings: ε=8-10, δ=1e-5 for moderate privacy; ε=1-3 for strong privacy (significant accuracy drop expected).

**Opacus** (PyTorch FL library for DP):

```python
from opacus import PrivacyEngine
from opacus.validators import ModuleValidator

model = ModuleValidator.fix(model)  # replaces BatchNorm with GroupNorm, etc.
optimizer = torch.optim.SGD(model.parameters(), lr=0.1)
privacy_engine = PrivacyEngine()
model, optimizer, train_loader = privacy_engine.make_private(
    module=model,
    optimizer=optimizer,
    data_loader=train_loader,
    noise_multiplier=1.1,
    max_grad_norm=1.0,
)
# Train normally; PrivacyEngine hooks intercept gradient computation
epsilon = privacy_engine.get_epsilon(delta=1e-5)
```

Opacus gotchas: (1) BatchNorm is incompatible with per-sample gradients — use `GroupNorm` or `LayerNorm`; (2) requires `batch_first=True` for RNNs; (3) `ModuleValidator.fix` patches incompatible layers automatically but may change model behavior — validate accuracy after fixing.

**Local DP vs. Central DP**: in local DP, each client randomizes their data before sending (stronger privacy guarantee, worse utility — each client's report is individually private). In central DP (Opacus / DP-SGD), the server adds noise to the aggregated update (weaker per-individual guarantee, much better utility). Federated learning with central DP requires a trusted aggregator; local DP does not.

### Secure Aggregation

Secure aggregation prevents the server from seeing individual client updates — only the sum is revealed. Uses cryptographic protocols:

**Pairwise masking** (Bonawitz et al. 2017): each pair of clients (i, j) agrees on a random mask r_ij. Client i adds r_ij and subtracts r_ji for all j≠i. Sum of masked updates = sum of actual updates (masks cancel). Dropout-resilient via secret sharing of the mask seeds.

**Homomorphic encryption (HE)**: clients encrypt updates under a public key; server aggregates encrypted values; only the aggregation result can be decrypted. CKKS scheme for approximate arithmetic on real-valued gradients. High computational overhead — practical only for small models or when combined with gradient compression.

**Trusted Execution Environments (TEEs)**: Intel SGX or ARM TrustZone as a hardware-based trusted aggregator. Clients encrypt updates to the TEE's attestation key; aggregation happens inside the enclave.

In practice, pairwise masking (implemented in PySyft and TensorFlow Federated) is the most deployed approach — it scales to thousands of clients and adds only ~2× communication overhead.

### Flower Framework

Flower (flwr) is the most mature open-source FL framework, supporting any ML framework (PyTorch, TensorFlow, JAX, scikit-learn).

```python
import flwr as fl
import torch

class FlowerClient(fl.client.NumPyClient):
    def get_parameters(self, config):
        return [val.cpu().numpy() for val in model.state_dict().values()]

    def fit(self, parameters, config):
        set_parameters(model, parameters)
        train(model, trainloader, epochs=config.get('local_epochs', 1))
        return self.get_parameters(config={}), len(trainloader.dataset), {}

    def evaluate(self, parameters, config):
        set_parameters(model, parameters)
        loss, accuracy = test(model, valloader)
        return float(loss), len(valloader.dataset), {'accuracy': float(accuracy)}

# Start client
fl.client.start_numpy_client(server_address='127.0.0.1:8080', client=FlowerClient())

# Server-side strategy
strategy = fl.server.strategy.FedAvg(
    fraction_fit=0.1,
    fraction_evaluate=0.05,
    min_fit_clients=10,
    min_evaluate_clients=5,
    min_available_clients=100,
)
fl.server.start_server(server_address='0.0.0.0:8080', config=fl.server.ServerConfig(num_rounds=50), strategy=strategy)
```

Custom strategies: subclass `fl.server.strategy.Strategy` and implement `configure_fit`, `aggregate_fit`, `configure_evaluate`, `aggregate_evaluate`. Use for custom aggregation (trimmed mean, Krum) or adaptive client selection.

### PySyft

PySyft (OpenMined) focuses on privacy primitives and data science on remote data. Concepts: `Domain` (a data owner's node), `Dataset` (data registered on a domain), `sy.login()` to connect. Data scientists submit code for approval; data owners run code in a sandboxed environment and return results (not raw data). Supports DP, SMPC (secure multi-party computation), and FL orchestration. More suitable for institutional data silo FL (hospitals, banks) than cross-device FL.

### Communication Compression

Communication is the bottleneck in cross-device FL (mobile, IoT). Two main approaches:

**Gradient quantization**: reduce bits per parameter. `1-bit SGD` (sign SGD): send only the sign of the gradient. Error feedback (accumulate quantization error and add to next round's gradient) is essential for convergence. `PowerSGD`: low-rank decomposition of gradient matrices — decompose G ≈ PQ^T, send P and Q (much smaller). Implemented in PyTorch's `torch.distributed` and Flower's `DefaultStrategy` with `fit_metrics_aggregation_fn`.

**Top-k sparsification**: send only the k largest-magnitude gradient components (k = 0.1-1% of total parameters). Client accumulates non-sent gradients in an error buffer. `torch.topk(grad.abs(), k)` for indices; send (indices, values) as sparse representation. Effective k choice: 0.001 often works (99.9% compression) with error feedback.

**Federated distillation**: instead of sending model weights, clients send soft predictions (logits) on a shared public dataset. Server aggregates logits (FedDF, Ensemble Distillation). Decouples client model architectures — clients can use heterogeneous models. Communication cost = |public_dataset| × num_classes floats, independent of model size.

### Non-IID Data Heterogeneity

Non-IID (non-independent and identically distributed) data is the fundamental challenge in FL. Types:
- **Label skew**: client i only has classes {dog, cat}; client j only has {car, plane}.
- **Feature skew**: same classes, different input distributions (e.g., different camera sensors).
- **Quantity skew**: highly imbalanced local dataset sizes.

Synthetic benchmarks: Dirichlet distribution with α parameter controls heterogeneity — `np.random.dirichlet([α]*num_classes)` to sample class proportions per client. α→∞ is IID; α=0.1 is strongly non-IID.

Mitigation strategies: (1) **FedProx** proximal term; (2) **SCAFFOLD** control variates; (3) **FedMA** (layer-wise matching and aggregation using permutation invariance); (4) **personalized FL** — maintain global model + small local adaptation layer; (5) **clustered FL** — identify groups of clients with similar data distributions, federate within clusters.

### Personalized Federated Learning

Pure global model convergence is suboptimal when data is highly heterogeneous. Personalization approaches:
- **Per-FedAvg**: train global model with MAML-style meta-learning; global model is a good initialization for fast local fine-tuning (1-10 gradient steps).
- **pFedMe**: each client maintains a personalized model w_i close to global w via Moreau envelope: min ||w_i - w||² + λF_i(w_i).
- **Ditto**: simultaneously train global model (FedAvg) and local model; local model minimized subject to staying close to global: min F_i(w_i) + (λ/2)||w_i - w_global||².
- **LG-FedAvg**: train shared lower layers globally, keep upper layers local.

### Model Poisoning Defenses

Federated learning is vulnerable to Byzantine clients submitting malicious updates.

**Attack types**: (1) **Model replacement**: malicious client scales up its update to dominate aggregation; (2) **Backdoor attack**: embed a trigger pattern — model predicts attacker-chosen class when trigger is present; (3) **Gradient inversion**: honest-but-curious server reconstructs training data from gradients (DLG attack).

**Defense mechanisms**:
- **Krum / Multi-Krum**: select the update(s) with the smallest sum of distances to their n-f-2 nearest neighbors (f = assumed number of Byzantine clients). Robust to f < n/2 Byzantine clients.
- **Trimmed Mean / Coordinate-wise Median**: for each parameter dimension, trim the top/bottom β fraction of values before averaging. Coordinate-wise median is Byzantine-robust but converges slower.
- **FLTrust**: server maintains a small clean root dataset; compute trust scores for each client update based on cosine similarity to the server's own gradient; weight aggregation by trust scores.
- **Differential privacy as defense**: adding DP noise bounds the influence of any single client's update, limiting poisoning impact. The noise that provides ε-DP also limits any single client's contribution to at most `clip_norm`.
- **Anomaly detection**: flag updates with abnormally large L2 norms (norm clipping + rejection) or that diverge significantly from the historical mean direction.

Backdoor defense: **DeepSight** clusters client updates and identifies outlier clusters; **FLAME** uses HDBSCAN clustering on flattened update vectors to identify poisoned clients before aggregation.
