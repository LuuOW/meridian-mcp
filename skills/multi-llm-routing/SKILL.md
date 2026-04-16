---
name: multi-llm-routing
description: Multi-LLM routing authority — provider selection, cost-aware tiering, fallback chains, latency budgets, health checks, A/B model testing, and unified client abstraction across Anthropic/OpenAI/Mistral
keywords: ["multi", "llm", "routing", "anthropic", "openai", "mistral", "multi-llm", "authority", "provider", "selection", "cost-aware", "tiering", "fallback", "chains", "latency", "budgets", "health", "checks", "a/b", "model"]
orb_class: trojan
---

# multi-llm-routing

Covers intelligent routing across multiple LLM providers: cost tiers, latency SLAs, provider health, fallback chains, and a unified client that hides provider-specific quirks.

## 1) Provider registry

```python
from dataclasses import dataclass, field
from enum import Enum

class Provider(str, Enum):
    ANTHROPIC = "anthropic"
    OPENAI    = "openai"
    MISTRAL   = "mistral"
    GROQ      = "groq"

@dataclass
class ModelSpec:
    provider:      Provider
    model_id:      str
    context_window: int
    cost_in:       float    # USD per 1M input tokens
    cost_out:      float    # USD per 1M output tokens
    avg_latency_ms: float   # p50 from benchmarks
    tier:          int      # 1=heavy, 2=standard, 3=fast/cheap

MODEL_REGISTRY: dict[str, ModelSpec] = {
    "opus":    ModelSpec(Provider.ANTHROPIC, "claude-opus-4-6",       200_000, 15.0, 75.0,  4000, 1),
    "sonnet":  ModelSpec(Provider.ANTHROPIC, "claude-sonnet-4-6",     200_000,  3.0, 15.0,  1500, 2),
    "haiku":   ModelSpec(Provider.ANTHROPIC, "claude-haiku-4-5-20251001", 200_000, 0.8,  4.0,   500, 3),
    "gpt4o":   ModelSpec(Provider.OPENAI,    "gpt-4o",                128_000,  5.0, 15.0,  2000, 2),
    "gpt4o-m": ModelSpec(Provider.OPENAI,    "gpt-4o-mini",           128_000,  0.15, 0.6,   700, 3),
    "mistral-l": ModelSpec(Provider.MISTRAL, "mistral-large-latest",  128_000,  2.0,  6.0,  1800, 2),
    "llama3":  ModelSpec(Provider.GROQ,      "llama3-70b-8192",         8_192,  0.59, 0.79,  300, 3),
}
```

## 2) Routing logic

```python
import asyncio, time
from typing import Literal

TaskType = Literal["reasoning", "extraction", "classification", "generation", "summarisation", "coding"]

TASK_TIER: dict[TaskType, int] = {
    "reasoning":      1,   # always use heavy model
    "coding":         2,   # standard
    "generation":     2,
    "summarisation":  3,   # cheap is fine
    "extraction":     3,
    "classification": 3,
}

# Per-provider health state (updated by health-check loop)
_provider_health: dict[Provider, bool] = {p: True for p in Provider}

def select_model(
    task: TaskType,
    input_tokens: int,
    budget_usd: float | None = None,
    max_latency_ms: float | None = None,
    prefer_provider: Provider | None = None,
) -> ModelSpec:
    tier = TASK_TIER[task]
    candidates = [
        spec for spec in MODEL_REGISTRY.values()
        if spec.tier >= tier
        and _provider_health[spec.provider]
        and spec.context_window >= input_tokens + 2048  # leave room for output
    ]
    if prefer_provider:
        preferred = [c for c in candidates if c.provider == prefer_provider]
        if preferred:
            candidates = preferred

    if max_latency_ms:
        candidates = [c for c in candidates if c.avg_latency_ms <= max_latency_ms] or candidates

    if budget_usd:
        candidates = [
            c for c in candidates
            if (input_tokens / 1_000_000 * c.cost_in) < budget_usd
        ] or candidates

    # Pick lowest cost from acceptable candidates at target tier
    target = [c for c in candidates if c.tier == tier] or candidates
    return min(target, key=lambda c: c.cost_in + c.cost_out)
```

## 3) Unified LLM client with fallback

```python
import anthropic, openai

_anthropic = anthropic.AsyncAnthropic()
_openai    = openai.AsyncOpenAI()

async def llm_call(
    prompt: str,
    task: TaskType = "generation",
    system: str = "You are a helpful assistant.",
    max_tokens: int = 2048,
    temperature: float = 0.3,
    budget_usd: float | None = None,
    fallback: bool = True,
) -> str:
    input_tokens = len(prompt) // 4   # rough estimate
    spec = select_model(task, input_tokens, budget_usd=budget_usd)

    async def _call(s: ModelSpec) -> str:
        if s.provider == Provider.ANTHROPIC:
            msg = await _anthropic.messages.create(
                model=s.model_id, max_tokens=max_tokens, temperature=temperature,
                system=system, messages=[{"role": "user", "content": prompt}],
            )
            return msg.content[0].text
        elif s.provider == Provider.OPENAI:
            resp = await _openai.chat.completions.create(
                model=s.model_id, max_tokens=max_tokens, temperature=temperature,
                messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            )
            return resp.choices[0].message.content
        raise ValueError(f"No client for provider: {s.provider}")

    try:
        return await _call(spec)
    except Exception as primary_err:
        if not fallback:
            raise
        # Mark provider unhealthy temporarily
        _provider_health[spec.provider] = False
        asyncio.get_event_loop().call_later(60, lambda: _provider_health.update({spec.provider: True}))
        # Retry with next best option
        fallback_spec = select_model(task, input_tokens, budget_usd=budget_usd)
        try:
            return await _call(fallback_spec)
        except Exception:
            raise primary_err   # raise original error for clearer debugging
```

## 4) Provider health-check loop

```python
import httpx

HEALTH_ENDPOINTS: dict[Provider, str] = {
    Provider.ANTHROPIC: "https://status.anthropic.com/api/v2/status.json",
    Provider.OPENAI:    "https://status.openai.com/api/v2/status.json",
}

async def check_provider_health():
    async with httpx.AsyncClient(timeout=5) as client:
        for provider, url in HEALTH_ENDPOINTS.items():
            try:
                r = await client.get(url)
                data = r.json()
                ok = data.get("status", {}).get("indicator", "none") in ("none", "minor")
                _provider_health[provider] = ok
            except Exception:
                _provider_health[provider] = False

async def health_loop(interval_s: int = 120):
    while True:
        await check_provider_health()
        await asyncio.sleep(interval_s)
```

## 5) Cost tracking

```python
from collections import defaultdict

_cost_log: list[dict] = []
_cost_totals: dict[str, float] = defaultdict(float)

def record_cost(model_key: str, input_tokens: int, output_tokens: int, task: str):
    spec = MODEL_REGISTRY[model_key]
    cost = (input_tokens / 1_000_000 * spec.cost_in) + (output_tokens / 1_000_000 * spec.cost_out)
    _cost_log.append({"model": model_key, "task": task, "cost": cost, "ts": time.time()})
    _cost_totals[model_key] += cost
    return cost

def cost_report(window_h: float = 24) -> dict:
    cutoff = time.time() - window_h * 3600
    recent = [e for e in _cost_log if e["ts"] >= cutoff]
    total = sum(e["cost"] for e in recent)
    by_model = defaultdict(float)
    for e in recent:
        by_model[e["model"]] += e["cost"]
    return {"total_usd": round(total, 4), "by_model": dict(by_model), "calls": len(recent)}
```

## 6) Model A/B routing

```python
import hashlib

def ab_route(user_id: str, experiment: str, model_a: str, model_b: str, split: float = 0.5) -> str:
    """Deterministic 50/50 (or custom) split by user."""
    h = int(hashlib.md5(f"{experiment}:{user_id}".encode()).hexdigest(), 16)
    return model_a if (h % 1000) / 1000 < split else model_b
```

## 7) Streaming unified client

```python
from anthropic import AsyncAnthropic
from openai import AsyncOpenAI

async def stream_call(prompt: str, model_key: str = "sonnet"):
    spec = MODEL_REGISTRY[model_key]
    if spec.provider == Provider.ANTHROPIC:
        async with _anthropic.messages.stream(
            model=spec.model_id, max_tokens=2048,
            messages=[{"role": "user", "content": prompt}],
        ) as stream:
            async for text in stream.text_stream:
                yield text
    elif spec.provider == Provider.OPENAI:
        stream = await _openai.chat.completions.create(
            model=spec.model_id, max_tokens=2048, stream=True,
            messages=[{"role": "user", "content": prompt}],
        )
        async for chunk in stream:
            if chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content
```

## 8) Checklist — multi-LLM routing

- [ ] MODEL_REGISTRY has current pricing (audit monthly — prices change)
- [ ] Each task type mapped to a tier — never default everything to Opus
- [ ] Fallback chain tested: primary failure → secondary provider auto-switch
- [ ] Provider health loop running every 120s (not polling per request)
- [ ] Cost tracking per call — weekly budget alerts if > $X
- [ ] Context window check before routing (don't send 150k tokens to gpt-4o)
- [ ] A/B routing deterministic per user (not random per request)
- [ ] Streaming implemented for generation tasks > 500 tokens
- [ ] Temperature 0 for extraction/classification, 0.3-0.7 for generation
- [ ] Unhealthy providers auto-recover after 60s (not permanently blacklisted)
