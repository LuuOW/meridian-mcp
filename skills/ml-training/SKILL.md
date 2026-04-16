---
name: ml-training
description: Machine learning model training authority — classifier and regressor training with scikit-learn and PyTorch, feature engineering, cross-validation, hyperparameter tuning, fine-tuning transformer models with HuggingFace, dataset splits, loss functions, learning rate schedules, and reproducible training runs
---

# ml-training

Production ML training: classifiers, regressors, and fine-tuned transformers. Covers dataset hygiene, feature engineering, cross-validation, hyperparameter tuning, and reproducible runs.

## Dataset Hygiene

```python
# Stratified train/val/test split — preserves class balance
from sklearn.model_selection import train_test_split
X_train, X_temp, y_train, y_temp = train_test_split(
    X, y, test_size=0.30, stratify=y, random_state=42
)
X_val, X_test, y_val, y_test = train_test_split(
    X_temp, y_temp, test_size=0.50, stratify=y_temp, random_state=42
)
# Result: 70/15/15 train/val/test
```

Always split BEFORE any feature engineering that uses target statistics (target encoding, target-aware imputation) — otherwise you leak test info into train.

```python
# Compute class weights for imbalanced problems
from sklearn.utils.class_weight import compute_class_weight
weights = compute_class_weight('balanced', classes=np.unique(y_train), y=y_train)
class_weight_dict = dict(zip(np.unique(y_train), weights))
```

## Feature Engineering

```python
from sklearn.preprocessing import StandardScaler, OneHotEncoder
from sklearn.compose import ColumnTransformer
from sklearn.pipeline import Pipeline

numeric_cols = ['age', 'income', 'tenure_days']
categorical_cols = ['region', 'plan_tier']

pre = ColumnTransformer([
    ('num', StandardScaler(), numeric_cols),
    ('cat', OneHotEncoder(handle_unknown='ignore', sparse_output=False), categorical_cols),
])

# ALWAYS wrap preprocessing in Pipeline — fit on train only, transform on val/test
pipe = Pipeline([('pre', pre), ('clf', GradientBoostingClassifier())])
pipe.fit(X_train, y_train)
preds = pipe.predict(X_val)
```

## Classifier Training (tabular)

```python
import xgboost as xgb
from sklearn.metrics import roc_auc_score, average_precision_score, classification_report

model = xgb.XGBClassifier(
    n_estimators=500,
    max_depth=6,
    learning_rate=0.05,
    subsample=0.8,
    colsample_bytree=0.8,
    reg_alpha=0.1,
    reg_lambda=1.0,
    eval_metric='aucpr',
    early_stopping_rounds=50,
    random_state=42,
)
model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=25)

y_proba = model.predict_proba(X_test)[:, 1]
print(f"ROC-AUC: {roc_auc_score(y_test, y_proba):.3f}")
print(f"PR-AUC : {average_precision_score(y_test, y_proba):.3f}")
```

For class-imbalanced data (fraud, anomaly), PR-AUC is far more informative than ROC-AUC.

## Cross-Validation

```python
from sklearn.model_selection import StratifiedKFold, cross_val_score

cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
scores = cross_val_score(pipe, X_train, y_train, cv=cv, scoring='roc_auc')
print(f"CV ROC-AUC: {scores.mean():.3f} ± {scores.std():.3f}")
```

For time-series, use `TimeSeriesSplit` to avoid look-ahead leakage.

## Hyperparameter Search

Prefer Bayesian over grid search — finds good hyperparameters in far fewer trials.

```python
import optuna

def objective(trial):
    params = {
        'max_depth':       trial.suggest_int('max_depth', 3, 10),
        'learning_rate':   trial.suggest_float('learning_rate', 1e-3, 0.3, log=True),
        'subsample':       trial.suggest_float('subsample', 0.5, 1.0),
        'colsample_bytree':trial.suggest_float('colsample_bytree', 0.5, 1.0),
        'reg_alpha':       trial.suggest_float('reg_alpha', 1e-8, 10.0, log=True),
        'reg_lambda':      trial.suggest_float('reg_lambda', 1e-8, 10.0, log=True),
    }
    model = xgb.XGBClassifier(**params, n_estimators=500, early_stopping_rounds=30)
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)
    return roc_auc_score(y_val, model.predict_proba(X_val)[:, 1])

study = optuna.create_study(direction='maximize')
study.optimize(objective, n_trials=100, timeout=3600)
print(f"Best ROC-AUC: {study.best_value:.3f}")
print(f"Best params:   {study.best_params}")
```

## Fine-Tuning Transformers (HuggingFace)

```python
from transformers import AutoTokenizer, AutoModelForSequenceClassification, TrainingArguments, Trainer
from datasets import Dataset

tok = AutoTokenizer.from_pretrained("distilbert-base-uncased")
model = AutoModelForSequenceClassification.from_pretrained(
    "distilbert-base-uncased", num_labels=3
)

def tokenize(batch):
    return tok(batch['text'], padding='max_length', truncation=True, max_length=256)

ds_train = Dataset.from_dict({'text': X_train, 'label': y_train}).map(tokenize, batched=True)
ds_val   = Dataset.from_dict({'text': X_val,   'label': y_val  }).map(tokenize, batched=True)

args = TrainingArguments(
    output_dir='./out',
    num_train_epochs=3,
    per_device_train_batch_size=16,
    per_device_eval_batch_size=32,
    learning_rate=2e-5,
    weight_decay=0.01,
    warmup_ratio=0.1,
    eval_strategy='epoch',
    save_strategy='epoch',
    load_best_model_at_end=True,
    metric_for_best_model='eval_loss',
    fp16=True,                         # half precision on supported GPUs
    gradient_accumulation_steps=2,
    report_to='none',                  # or 'wandb' / 'tensorboard'
)

trainer = Trainer(model=model, args=args, train_dataset=ds_train, eval_dataset=ds_val)
trainer.train()
trainer.save_model('./my-classifier')
```

## PyTorch Training Loop

```python
import torch
from torch.utils.data import DataLoader

model = MyModel().to(device)
opt = torch.optim.AdamW(model.parameters(), lr=3e-4, weight_decay=0.01)
scheduler = torch.optim.lr_scheduler.OneCycleLR(
    opt, max_lr=3e-4, total_steps=len(train_loader) * EPOCHS
)
loss_fn = torch.nn.CrossEntropyLoss()
scaler = torch.amp.GradScaler(device)

for epoch in range(EPOCHS):
    model.train()
    for x, y in train_loader:
        x, y = x.to(device), y.to(device)
        opt.zero_grad()
        with torch.amp.autocast(device):
            logits = model(x)
            loss = loss_fn(logits, y)
        scaler.scale(loss).backward()
        scaler.unscale_(opt)
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)   # gradient clipping
        scaler.step(opt)
        scaler.update()
        scheduler.step()
```

## Reproducibility

```python
import random, numpy as np, torch

SEED = 42
random.seed(SEED); np.random.seed(SEED); torch.manual_seed(SEED)
torch.cuda.manual_seed_all(SEED)
torch.backends.cudnn.deterministic = True
torch.backends.cudnn.benchmark = False
```

Every training run should persist: seed, git SHA, dataset hash, hyperparameters, final metrics. MLflow, Weights&Biases, or just a JSON manifest — pick one and use it religiously.

## Production Checklist

- [ ] Train/val/test split BEFORE any target-aware preprocessing
- [ ] Class weights or resampling for imbalanced targets
- [ ] Cross-validation score matches held-out test score (within 1-2%)
- [ ] Hyperparameter search via Optuna, not manual grid
- [ ] PR-AUC reported for imbalanced problems (not just ROC-AUC)
- [ ] Calibration curve checked — probabilities should match frequencies
- [ ] SHAP values inspected for top features (no label leakage)
- [ ] Seed fixed, dependencies frozen in requirements.txt
- [ ] Model artifact + preprocessor saved together (Pipeline, not two files)
- [ ] Inference latency benchmarked on CPU and target hardware
- [ ] Drift monitoring plan in production (input distribution, output distribution, performance)
