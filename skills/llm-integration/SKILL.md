---
name: llm-integration
description: Claude and OpenAI API patterns, prompt design, context management, streaming, tool use, cost control, multi-model routing
---

# llm-integration

Practical patterns for integrating Claude (Anthropic) and OpenAI into production pipelines — prompting, streaming, tool use, cost tracking, and multi-model routing.

## 1) Anthropic client (Python)

```python
import anthropic

client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

# Simple completion
message = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=2048,
    messages=[{"role": "user", "content": prompt}],
)
text = message.content[0].text

# With system prompt
message = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=4096,
    system="You are a precise SEO article writer. Output only valid markdown.",
    messages=[{"role": "user", "content": f"Write about: {topic}"}],
)
```

## 2) OpenAI client (Python)

```python
from openai import AsyncOpenAI

client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))

response = await client.chat.completions.create(
    model="gpt-4o",
    messages=[
        {"role": "system", "content": system_prompt},
        {"role": "user",   "content": user_prompt},
    ],
    max_tokens=2048,
    temperature=0.3,
)
text = response.choices[0].message.content
tokens_used = response.usage.total_tokens
```

## 3) Streaming responses

```python
# Anthropic stream
with client.messages.stream(
    model="claude-sonnet-4-6",
    max_tokens=4096,
    messages=[{"role": "user", "content": prompt}],
) as stream:
    for chunk in stream.text_stream:
        print(chunk, end="", flush=True)
    message = stream.get_final_message()

# OpenAI stream
stream = await client.chat.completions.create(model="gpt-4o", messages=msgs, stream=True)
async for chunk in stream:
    delta = chunk.choices[0].delta.content or ""
    print(delta, end="", flush=True)
```

## 4) Tool use / function calling (Claude)

```python
tools = [{
    "name": "search_web",
    "description": "Search the web and return top results",
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query"},
        },
        "required": ["query"],
    },
}]

response = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    tools=tools,
    messages=[{"role": "user", "content": "What are the latest keto trends?"}],
)

# Handle tool call
if response.stop_reason == "tool_use":
    tool_use = next(b for b in response.content if b.type == "tool_use")
    tool_result = await search_web(tool_use.input["query"])

    # Continue conversation with result
    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2048,
        tools=tools,
        messages=[
            {"role": "user", "content": "What are the latest keto trends?"},
            {"role": "assistant", "content": response.content},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tool_use.id, "content": str(tool_result)}]},
        ],
    )
```

## 5) Retry with back-off (production must-have)

```python
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
import anthropic

@retry(
    retry=retry_if_exception_type((anthropic.RateLimitError, anthropic.APIStatusError)),
    wait=wait_exponential(multiplier=2, min=4, max=60),
    stop=stop_after_attempt(5),
)
async def generate_with_retry(prompt: str) -> str:
    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2048,
        messages=[{"role": "user", "content": prompt}],
    )
    return message.content[0].text
```

## 6) Multi-model routing (cost vs. quality)

```python
MODEL_TIERS = {
    "fast":    "claude-haiku-4-5-20251001",   # cheap, quick — classification, summaries
    "default": "claude-sonnet-4-6",            # balanced — most tasks
    "strong":  "claude-opus-4-6",              # expensive — complex reasoning, final edit
}

def pick_model(task: str, word_count: int = 0) -> str:
    if task in ("classify", "extract", "summarise") or word_count < 200:
        return MODEL_TIERS["fast"]
    if task in ("reason", "critique", "plan") or word_count > 2000:
        return MODEL_TIERS["strong"]
    return MODEL_TIERS["default"]
```

## 7) Context window management

```python
import tiktoken

enc = tiktoken.get_encoding("cl100k_base")   # GPT-4 / Claude approximation

def count_tokens(text: str) -> int:
    return len(enc.encode(text))

def fit_to_window(docs: list[str], max_tokens: int = 80_000) -> list[str]:
    """Trim doc list to fit within context budget."""
    kept, total = [], 0
    for doc in sorted(docs, key=len):   # shortest first
        t = count_tokens(doc)
        if total + t > max_tokens:
            break
        kept.append(doc)
        total += t
    return kept

# Rule of thumb — always leave room for output
CONTEXT_BUDGET = 150_000   # model limit
OUTPUT_RESERVE = 8_000
INPUT_BUDGET   = CONTEXT_BUDGET - OUTPUT_RESERVE
```

## 8) Cost tracking

```python
# Anthropic pricing (per million tokens, April 2025 approx)
PRICES = {
    "claude-opus-4-6":           {"in": 15.00, "out": 75.00},
    "claude-sonnet-4-6":         {"in":  3.00, "out": 15.00},
    "claude-haiku-4-5-20251001": {"in":  0.80, "out":  4.00},
    "gpt-4o":                    {"in":  2.50, "out": 10.00},
}

def estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    p = PRICES.get(model, {"in": 3.0, "out": 15.0})
    return (input_tokens * p["in"] + output_tokens * p["out"]) / 1_000_000

# Log after every call
cost = estimate_cost(model, usage.input_tokens, usage.output_tokens)
log.info("llm_call", model=model, cost_usd=round(cost, 6), tokens=usage.total_tokens)
```

## 9) Prompt design patterns

```python
# Structured output — ask for JSON explicitly
SYSTEM = """
You are a data extractor. Always respond with valid JSON only.
Schema: {"entities": [{"name": str, "type": str, "relevance": float}]}
"""

# Chain-of-thought for complex reasoning
SYSTEM = """
Think step by step. Show your reasoning inside <thinking> tags,
then give your final answer after </thinking>.
"""

# Persona + constraint
SYSTEM = f"""
You are an expert {niche} writer. Rules:
- Output only the article body in markdown
- No intro like "Sure!" or "Here is..."
- Word count: {word_count} ± 10%
- Include exactly {h2_count} H2 headings
"""
```

## 10) Checklist

- [ ] Retry logic with exponential back-off on every LLM call (rate limits happen)
- [ ] Log `model`, `input_tokens`, `output_tokens`, `cost_usd` on every call
- [ ] Context budget enforced — never silently truncate; raise if over limit
- [ ] Model tier routing — don't use Opus for classification tasks
- [ ] System prompt versioned (store in file, not inline strings)
- [ ] Streaming used for long outputs (>500 tokens) — better UX, same cost
- [ ] API keys in env vars, never hardcoded
- [ ] Graceful degradation — if LLM fails after retries, return a meaningful error, not a 500
