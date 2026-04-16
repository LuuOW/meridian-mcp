---
name: causal-inference
description: Causal inference for data scientists and analysts — DAGs and do-calculus, propensity score methods, difference-in-differences, instrumental variables, regression discontinuity, synthetic control, and variance reduction techniques (CUPED), using CausalML, DoWhy, and rigorous A/B test analysis.
orb_class: comet
keywords: ["causal-inference", "dag", "do-calculus", "propensity-score", "matching", "difference-in-differences", "instrumental-variables", "regression-discontinuity", "synthetic-control", "cuped", "causalml", "dowhy", "ab-testing", "ate", "att", "confounder", "counterfactual", "heterogeneous-treatment-effects", "uplift-modeling", "mediation-analysis"]
---

# Causal Inference

Causal inference is the discipline of estimating cause-and-effect relationships from data — answering "what would have happened?" rather than "what is correlated with what?" This skill covers the identification strategies that make causal claims defensible (DAGs, assumptions, estimation methods) and the computational tools (CausalML, DoWhy) that implement them. It appears alongside analytics and ML engineering whenever the goal is decision-making, not prediction.

## Core Concepts

### DAGs and the Language of Causation

A Directed Acyclic Graph (DAG) is the formal representation of causal assumptions. Nodes are variables; directed edges represent direct causal effects. Three fundamental structures:

- **Chain**: X → M → Y. M is a mediator. Controlling for M blocks the path (bad if you want total effect; intentional for direct effect).
- **Fork (Common Cause)**: X ← C → Y. C is a confounder. Controlling for C blocks the backdoor path and removes confounding.
- **Collider**: X → C ← Y. Controlling for C (or conditioning on it in sampling) opens a spurious path — this is selection bias. Never control for a collider.

**Backdoor criterion**: a set Z blocks all backdoor paths from treatment T to outcome Y (paths with an arrow into T) and contains no descendants of T. If such Z exists and is observed, the causal effect is identified by adjustment: P(Y | do(T)) = Σ_z P(Y | T, Z=z) P(Z=z).

**Do-calculus** (Pearl): three rules for transforming expressions with `do()` operators into observational distributions. In practice, use the backdoor/frontdoor criteria rather than applying do-calculus rules manually. DoWhy handles identification automatically given a graph.

**Identification gotcha**: unmeasured confounders break identification from observational data. Always draw the full DAG before choosing an estimator — the choice of method is determined by the graph structure and which variables are observed.

### DoWhy

DoWhy formalizes the four-step process: **model** → **identify** → **estimate** → **refute**.

```python
import dowhy
from dowhy import CausalModel

model = CausalModel(
    data=df,
    treatment='treatment',
    outcome='revenue',
    common_causes=['age', 'region', 'prior_usage'],
    # or pass a graph: graph='digraph {treatment -> revenue; age -> treatment; age -> revenue}'
)
identified_estimand = model.identify_effect(proceed_when_unidentifiable=False)
estimate = model.estimate_effect(
    identified_estimand,
    method_name='backdoor.propensity_score_matching',
    target_units='att',  # average treatment effect on treated
)
refutation = model.refute_estimate(
    identified_estimand, estimate,
    method_name='random_common_cause'  # add random noise variable, ATE should not change
)
```

Refutation methods: `random_common_cause` (robustness to unmeasured confounders), `placebo_treatment_refuter` (replace treatment with random, ATE should → 0), `data_subset_refuter` (bootstrap subsets, ATE should be stable), `add_unobserved_common_cause` (sensitivity analysis — how strong would an unmeasured confounder need to be to explain away the effect?).

### Propensity Score Methods

The propensity score e(X) = P(T=1 | X) summarizes all confounders into a scalar. Under strong ignorability (no unmeasured confounders + overlap), conditioning on e(X) is sufficient.

**Estimation**: logistic regression for simplicity; gradient boosted trees (XGBoost) for better balance in high-dimensional settings. Check overlap: plot propensity score histograms for treated vs. control — poor overlap (scores near 0 or 1 for all treated units) signals violation of positivity assumption.

**Propensity Score Matching (PSM)**: for each treated unit, find the nearest control by propensity score (1-NN or k-NN matching). Caliper matching (restrict to matches within 0.2 SD of the logit of the propensity score) reduces bias from poor matches. Assess balance via standardized mean differences (SMD) — target |SMD| < 0.1 for all covariates post-matching.

**Inverse Probability Weighting (IPW)**: weights = T/e(X) + (1-T)/(1-e(X)). Estimate ATE as weighted mean difference. Stabilized weights (multiply by marginal P(T=1)) reduce variance. Trim extreme weights (e.g., cap at 99th percentile) to control variance at cost of slight bias.

**Doubly Robust (AIPW)**: combines outcome model + propensity model. Consistent if either model is correctly specified (not both need to be). This is the estimator to default to:

```python
from econml.dr import LinearDRLearner
est = LinearDRLearner(model_propensity=LogisticRegressionCV(), model_regression=LGBMRegressor())
est.fit(Y, T, X=X, W=W)  # X: effect modifiers, W: controls
ate = est.ate(X)
```

### Difference-in-Differences (DiD)

DiD estimates the causal effect of a treatment by comparing pre/post changes in the treated group to pre/post changes in a control group. Core assumption: **parallel trends** — in the absence of treatment, both groups would have evolved similarly.

Two-way fixed effects (TWFE) regression:

```
Y_it = α_i + γ_t + β · (Treated_i × Post_t) + ε_it
```

β is the DiD estimator (ATT). Implement with `statsmodels` panel or `linearmodels`:

```python
from linearmodels.panel import PanelOLS
mod = PanelOLS.from_formula('outcome ~ treated_x_post + EntityEffects + TimeEffects', data=df)
res = mod.fit(cov_type='clustered', cluster_entity=True)
```

**Parallel trends test**: plot pre-treatment trends; run an event study (leads and lags of treatment indicator). Pre-treatment coefficients should be statistically indistinguishable from zero. Non-zero pre-trends = parallel trends violated.

**Staggered adoption DiD** (Callaway-Sant'Anna): when units adopt treatment at different times, TWFE DiD with heterogeneous treatment timing gives biased estimates (negative-weight problem). Use `csdid` in Python or `did` R package. Estimates group-time ATTs: ATT(g, t) for each cohort g treated at time t, then aggregate.

### Instrumental Variables (IV)

IV estimates Local Average Treatment Effect (LATE) for compliers when there is an unobserved confounder. Instrument Z must satisfy: (1) **Relevance**: Z causally affects treatment T (testable — F-statistic > 10 in first stage); (2) **Exclusion restriction**: Z affects Y only through T (untestable — requires domain knowledge); (3) **Independence**: Z is as good as randomly assigned given covariates.

Two-Stage Least Squares (2SLS):

```python
from linearmodels.iv import IV2SLS
res = IV2SLS.from_formula(
    'revenue ~ 1 + controls + [treatment ~ instrument]', data=df
).fit(cov_type='robust')
```

Weak instrument test: Cragg-Donald or Kleibergen-Paap F-statistic (robust to heteroskedasticity) — rule of thumb F > 10, but Stock-Yogo critical values are more precise. Weak instruments cause large IV standard errors and potential finite-sample bias toward OLS.

Classic IV examples: randomized encouragement (Z = encouraged to take program, T = actually took it), supply-side shifters in demand estimation, distance to college as instrument for education.

### Regression Discontinuity (RD)

Units just above and just below an arbitrary threshold are treated as-if randomized. Sharp RD: treatment is a deterministic function of the running variable X at cutoff c. Fuzzy RD: treatment probability jumps at c (use as IV).

Bandwidth selection: Imbens-Kalyanaraman (IK) or Calonico-Cattaneo-Titiunik (CCT) optimal bandwidth. Use the `rdrobust` package (R) or `rdrobust` Python port. Local linear regression (not polynomial — Gelman & Imbens warn against high-degree polynomials) within bandwidth. Donut hole RD: exclude observations very close to the threshold to address manipulation/heaping.

Validity tests: (1) density test (McCrary test) — the density of the running variable should not jump at the cutoff; (2) covariate continuity — predetermined covariates should not jump at the cutoff; (3) placebo cutoffs — estimate RD at fake thresholds, should be zero.

### Synthetic Control

When you have one (or few) treated units and many potential controls, and DiD's parallel trends is implausible, construct a weighted combination of control units that best matches the treated unit's pre-treatment outcome trajectory.

```python
from pysynth import Synth
synth = Synth()
synth.fit(dataprep_dict)  # treated_unit, control_units, outcome_var, predictors, time_range
synth.plot(time_period=[pre_period, post_period])
```

The gap between actual and synthetic control post-treatment is the estimated effect. Inference via permutation (placebo tests): apply synthetic control to each control unit as if treated; the treated unit's gap should be extreme relative to the placebo distribution. Augmented Synthetic Control (Ben-Michael et al.) via `SparseSC` adds regularization and handles poor pre-treatment fit better.

### CUPED (Controlled-experiment Using Pre-Experiment Data)

CUPED reduces variance in A/B test estimators using pre-experiment covariates (typically the pre-experiment value of the outcome metric). The CUPED-adjusted estimator:

```
Ŷ_cuped = Ȳ_treatment - Ȳ_control - θ(X̄_treatment - X̄_control)
θ = Cov(Y, X) / Var(X)   [estimated on control group or pooled pre-experiment data]
```

Variance reduction: `Var(Ŷ_cuped) = Var(Y)(1 - ρ²)` where ρ is the correlation between Y and X. If pre-experiment metric correlates 0.7 with the experiment metric, variance drops by 51%, meaning you need roughly half the sample size for the same power.

Implementation: compute θ on pre-experiment period, apply adjustment to experiment observations. Multiple covariates: use OLS residuals (regress Y on X, use residuals as the adjusted metric). CUPED is equivalent to ANCOVA with pre-experiment covariate.

### CausalML and Heterogeneous Treatment Effects

HTE / CATE (Conditional Average Treatment Effect): τ(x) = E[Y(1) - Y(0) | X=x]. Who benefits most from the treatment?

```python
from causalml.inference.tree import UpliftTreeClassifier, UpliftRandomForestClassifier
from causalml.inference.meta import TLearner, SLearner, XLearner, RLearner

# T-Learner: separate outcome models for treated/control
learner = TLearner(models=[LGBMRegressor(), LGBMRegressor()])
learner.fit(X, treatment, y)
cate = learner.predict(X_test)

# X-Learner: better for imbalanced treatment assignment
x_learner = XLearner(models=[LGBMRegressor(), LGBMRegressor()])
x_learner.fit(X, treatment, y, p=propensity_scores)
```

**R-Learner** (Robinson decomposition) is the gold standard for CATE with observational data — orthogonalizes both outcome and treatment residuals before fitting the CATE model, achieving Neyman-orthogonality (robust to nuisance model misspecification). Implemented in `econml.metalearners.RLearner` and EconML's `CausalForestDML`.

Evaluation of CATE models: Qini coefficient (uplift equivalent of AUC), AUUC (Area Under Uplift Curve), and RATE (Rank-Weighted Average Treatment Effect, introduced by Athey & Wager). Never evaluate CATE on held-out data using ATE — you need a proper ranking-based metric.
