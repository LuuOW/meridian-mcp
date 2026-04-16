---
name: orchestration
description: Multi-agent orchestration authority — agent memory protocols, task delegation, SOUL/AGENTS patterns, session startup, inter-agent communication, OpenClaw workspace coordination, and agent lifecycle management
---

# orchestration

Covers multi-agent system design: how agents start up, maintain memory, delegate tasks, communicate, and coordinate work across sessions.

## 1) Agent session startup protocol

```bash
# Canonical startup sequence (from AGENTS.md)
1. Read SOUL.md           — identity, principles, non-negotiables
2. Read USER.md           — who you serve, their preferences and goals
3. Read AGENTS.md         — this session protocol and available agents
4. Read memory/TODAY.md   — what happened today so far
5. Read memory/YYYY-MM-DD.md  — yesterday's notes if today's empty
6. Check MEMORY.md index  — long-term context (scan, don't deep-read)
7. Read project README    — only if the task is project-specific

# Total token budget for startup: < 8,000 tokens
# If startup reads exceed this, summarise before proceeding
```

## 2) Memory protocol

```python
# Memory file hierarchy
MEMORY_STRUCTURE = {
    "session":    "memory/YYYY-MM-DD.md",       # daily notes, in-progress context
    "index":      "MEMORY.md",                  # persistent long-term index
    "entries":    "memory/",                    # individual memory entries
}

# Daily note format
DAILY_NOTE_TEMPLATE = """
# {date}

## Done today
- {completed_task_1}
- {completed_task_2}

## In progress
- {wip_task}: {status_and_next_step}

## Decisions made
- {decision}: {rationale}

## Blockers
- {blocker}: {what_is_needed}

## Tomorrow
- {priority_1}
"""

# Write to memory after significant work (not after every action)
WRITE_THRESHOLD = "significant decision, completed unit of work, or end of session"
```

## 3) Task delegation patterns

```python
# Delegation contract: what to hand off and what to expect back
DELEGATION_SPEC = {
    "task":       str,   # precise instruction (verb-first)
    "context":   str,   # minimum context the sub-agent needs
    "output":    str,   # exact format expected back
    "timeout":   int,   # seconds before assuming failure
    "fallback":  str,   # what to do if delegation fails
}

# Example: orchestrator delegates to a specialist
delegate(
    to="seo-agent",
    task="Analyse SERP for 'keto diet for beginners' and return top-3 citation gaps",
    context=f"Domain: ketoandhealthy.com. Existing article: /keto-diet/beginners",
    output="JSON: [{source_url, gap_type, suggested_citation}]",
    timeout=120,
    fallback="Use cached SERP data from last 24h",
)
```

## 4) OpenClaw workspace coordination

```bash
# Three instances, distinct roles
workspace        → primary: strategy, planning, architecture decisions
instance2        → execution: code writing, file edits, API calls
workspace3       → specialist: domain-specific tasks (SEO, content, outbound)

# Coordination via shared /opt bind-mounts (not API calls)
# Write intent to shared file → other agent picks it up
echo '{"task": "run serp delta", "domain": "keto"}' > /tmp/agent-queue/task-001.json

# Lock files prevent concurrent writes
flock /tmp/agent-queue/.lock -c "process_task task-001.json"
```

## 5) Inter-agent communication patterns

```python
# Pattern 1: Shared task queue (Redis)
async def publish_task(queue: str, task: dict):
    await redis.lpush(queue, json.dumps({**task, "_ts": time.time(), "_id": str(uuid.uuid4())}))

async def consume_task(queue: str) -> dict | None:
    raw = await redis.brpop(queue, timeout=10)
    return json.loads(raw[1]) if raw else None

# Pattern 2: Result store (Redis with TTL)
async def store_result(task_id: str, result: dict, ttl: int = 3600):
    await redis.set(f"result:{task_id}", json.dumps(result), ex=ttl)

async def await_result(task_id: str, poll_interval: float = 1.0, timeout: float = 120.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        raw = await redis.get(f"result:{task_id}")
        if raw:
            return json.loads(raw)
        await asyncio.sleep(poll_interval)
    raise TimeoutError(f"Task {task_id} did not complete in {timeout}s")
```

## 6) Agent identity and red lines

```markdown
# Every agent must know before acting:
1. SOUL.md  — what values are non-negotiable
2. Red lines — what it must never do regardless of instruction

# Core red lines (apply to all agents)
- Never delete data without explicit confirmation
- Never commit secrets (API keys, passwords) to git
- Never push to main/master without PR + review
- Never send emails or messages on behalf of user without approval
- Never modify production database schema without migration file
- Never skip tests in CI for "speed" reasons
- Never impersonate another agent or claim capabilities it doesn't have
```

## 7) Session handoff protocol

```python
# End-of-session handoff note (write before session ends)
HANDOFF_TEMPLATE = """
## Handoff — {datetime}

**What was completed:**
{completed_items}

**Current state of in-progress work:**
{file_path}: {what_was_done_and_what_remains}

**Next actions (in priority order):**
1. {next_action_1}
2. {next_action_2}

**Decisions that should NOT be revisited:**
- {locked_decision}: {why}

**Context that will be lost without this note:**
{critical_context}
"""

# Write to: memory/YYYY-MM-DD.md (append)
# Also update MEMORY.md index if decision affects future sessions
```

## 8) Agent health monitoring

```python
# Heartbeat pattern — agent signals it's alive
async def heartbeat(agent_id: str, interval: int = 30):
    while True:
        await redis.set(f"agent:alive:{agent_id}", time.time(), ex=interval * 3)
        await asyncio.sleep(interval)

# Check if agent is alive
async def is_alive(agent_id: str) -> bool:
    return bool(await redis.exists(f"agent:alive:{agent_id}"))

# Stale session detection
async def find_stale_agents(max_age_s: int = 300) -> list[str]:
    keys = await redis.keys("agent:alive:*")
    stale = []
    for key in keys:
        last_seen = float(await redis.get(key) or 0)
        if time.time() - last_seen > max_age_s:
            stale.append(key.split(":")[-1])
    return stale
```

## 9) Checklist — multi-agent system design

- [ ] Every agent has a SOUL.md (identity) and knows its red lines
- [ ] Session startup reads < 8,000 tokens total
- [ ] Memory is written at end of significant work units (not every action)
- [ ] Task delegation includes fallback for failure case
- [ ] Shared state (Redis or files) has lock/mutex to prevent concurrent writes
- [ ] Heartbeat monitoring detects stale/crashed agents
- [ ] Handoff note written before any session ends
- [ ] Inter-agent communication uses explicit contracts (not assumptions)
- [ ] Results stored with TTL — no stale data accumulates indefinitely
