---
name: reasoning
description: AI reasoning authority — prompt engineering, chain-of-thought, self-consistency, evaluation frameworks, LLM judging, structured output, and prompt versioning patterns for production AI systems
keywords: ["reasoning", "ai", "llm", "prompt", "authority", "engineering", "chain-of-thought", "self-consistency", "evaluation", "frameworks", "judging", "structured", "output", "versioning", "patterns", "production"]
orb_class: moon
---

# reasoning

Covers how to reliably extract high-quality reasoning from LLMs: prompt design, decomposition strategies, output validation, and evaluation at scale.

## 1) Prompt architecture patterns

```python
# Structure: System → Context → Task → Constraints → Output format
PROMPT_TEMPLATE = """
[SYSTEM]
You are {persona}. {core_capability_statement}.

[CONTEXT]
{relevant_background}

[TASK]
{specific_instruction_verb_first}

[CONSTRAINTS]
- {constraint_1}
- {constraint_2}

[OUTPUT FORMAT]
{exact_format_specification}
"""

# Verb-first task instructions improve instruction-following
GOOD = "Classify the following text as..."
BAD  = "I would like you to think about classifying..."
```

## 2) Chain-of-thought (CoT)

```python
# Zero-shot CoT — append "Think step by step"
def zero_shot_cot(question: str) -> str:
    return f"{question}\n\nThink step by step before giving your final answer."

# Few-shot CoT — provide worked examples
FEW_SHOT_COT = """
Q: Is the keto diet safe for type 2 diabetics?
Thinking: Type 2 diabetes involves insulin resistance. Keto reduces carbs → lower blood glucose →
reduced insulin demand. Studies show HbA1c improvements. Risk: hypoglycaemia if on medication.
Answer: Generally beneficial but requires medical supervision and medication adjustment.

Q: {new_question}
Thinking:"""

# Scratchpad pattern — separate reasoning from answer
SCRATCHPAD = """
Work through this in a <scratchpad> block, then give your final answer after </scratchpad>.

{question}
"""
```

## 3) Self-consistency (ensemble reasoning)

```python
# Generate N independent answers, take majority vote
async def self_consistent_answer(prompt: str, n: int = 5, temperature: float = 0.7) -> str:
    answers = await asyncio.gather(*[
        llm_call(prompt, temperature=temperature) for _ in range(n)
    ])
    # Extract final answers and vote
    finals = [extract_final_answer(a) for a in answers]
    from collections import Counter
    return Counter(finals).most_common(1)[0][0]

# Useful when: high-stakes classification, numeric estimation, factual Q&A
# Not useful when: creative writing, style tasks, open-ended generation
```

## 4) Structured output patterns

```python
# Pydantic-forced JSON output (Anthropic)
from pydantic import BaseModel

class ArticleAnalysis(BaseModel):
    topic: str
    sentiment: str       # positive | negative | neutral
    key_claims: list[str]
    confidence: float    # 0-1

def extract_structured(text: str) -> ArticleAnalysis:
    prompt = f"""
Analyse this text and respond with valid JSON matching this schema:
{ArticleAnalysis.model_json_schema()}

Text: {text}

Respond with JSON only, no explanation.
"""
    raw = llm_call(prompt, temperature=0)
    return ArticleAnalysis.model_validate_json(raw)

# Retry on parse failure
import tenacity

@tenacity.retry(stop=tenacity.stop_after_attempt(3))
def safe_structured_extract(text: str) -> ArticleAnalysis:
    return extract_structured(text)
```

## 5) LLM-as-judge evaluation

```python
JUDGE_PROMPT = """
You are an expert evaluator. Score the following {task_type} response on a scale of 1-5.

Criteria:
{criteria}

Reference answer (ground truth):
{reference}

Model response:
{response}

Output JSON: {{"score": int, "reasoning": str, "pass": bool}}
"""

async def evaluate_batch(
    responses: list[dict],
    criteria: str,
    pass_threshold: int = 4,
) -> dict:
    scores = []
    for item in responses:
        result = await llm_call(
            JUDGE_PROMPT.format(
                task_type=item["task"],
                criteria=criteria,
                reference=item["reference"],
                response=item["response"],
            ),
            model="claude-opus-4-6",   # use strongest model as judge
            temperature=0,
        )
        scores.append(json.loads(result))
    pass_rate = sum(1 for s in scores if s["pass"]) / len(scores)
    return {"pass_rate": pass_rate, "avg_score": sum(s["score"] for s in scores) / len(scores), "details": scores}
```

## 6) Prompt versioning

```python
# Store prompts as files, not inline strings
# /opt/{project}/prompts/{agent_name}/{version}.md

# Prompt registry
PROMPTS: dict[str, str] = {}

def load_prompt(name: str, version: str = "latest") -> str:
    path = Path(f"/opt/seo-geo-aeo-engine/prompts/{name}/{version}.md")
    if not path.exists() and version == "latest":
        # Find highest version
        versions = sorted(Path(f"/opt/seo-geo-aeo-engine/prompts/{name}").glob("v*.md"))
        path = versions[-1] if versions else path
    return path.read_text()

# Prompt A/B testing
async def prompt_ab_test(prompt_a: str, prompt_b: str, inputs: list[str], judge_criteria: str) -> dict:
    results_a = [await llm_call(prompt_a + "\n\n" + inp) for inp in inputs]
    results_b = [await llm_call(prompt_b + "\n\n" + inp) for inp in inputs]
    score_a   = await evaluate_batch([{"task": "generation", "reference": "", "response": r} for r in results_a], judge_criteria)
    score_b   = await evaluate_batch([{"task": "generation", "reference": "", "response": r} for r in results_b], judge_criteria)
    return {"winner": "A" if score_a["avg_score"] > score_b["avg_score"] else "B", "a": score_a, "b": score_b}
```

## 7) Decomposition strategies

```python
# Plan-and-execute: break task into steps, execute each
async def plan_and_execute(task: str) -> str:
    plan = await llm_call(f"Break this task into 3-7 numbered steps:\n{task}", temperature=0)
    steps = parse_numbered_list(plan)
    results = []
    for step in steps:
        result = await llm_call(
            f"Complete this step:\n{step}\n\nContext from previous steps:\n{chr(10).join(results[-2:])}"
        )
        results.append(result)
    return await llm_call(f"Synthesise these step results into a final answer:\n{chr(10).join(results)}")

# Reduce: map → reduce for long documents
async def map_reduce_summarise(chunks: list[str], question: str) -> str:
    summaries = await asyncio.gather(*[
        llm_call(f"Summarise the relevant parts for: {question}\n\n{chunk}") for chunk in chunks
    ])
    return await llm_call(f"Synthesise into a complete answer to: {question}\n\n" + "\n\n".join(summaries))
```

## 8) Checklist — production prompt design

- [ ] System prompt defines persona + capability (not just instructions)
- [ ] Task instruction starts with a verb ("Classify", "Extract", "Summarise")
- [ ] Output format specified exactly (JSON schema, markdown, plain text)
- [ ] Temperature set to 0 for deterministic tasks; 0.3-0.7 for creative
- [ ] Retry logic on structured output parse failure (3 attempts)
- [ ] Prompts stored as versioned files, not inline strings
- [ ] LLM-as-judge evaluation run on ≥ 50 samples before shipping
- [ ] Strongest model (Opus) used as judge, not as primary worker
- [ ] Chain-of-thought used for multi-step reasoning tasks
- [ ] Self-consistency (N≥5) used for high-stakes single answers
