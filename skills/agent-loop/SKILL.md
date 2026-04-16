---
name: agent-loop
description: Production Claude agent loop — Session/Harness/Registry/Tool abstraction, DRY_RUN safety guard, APScheduler integration, dead-letter error handling, tool registry, and observability hooks for autonomous agent systems
---

# agent-loop

Production patterns for building autonomous agent loops with the Anthropic API. Covers the Session/Harness/Registry/Tool abstraction, safe development mode via DRY_RUN, APScheduler cron integration, and observability hooks. Designed for systems that run unsupervised on a schedule and must never silently bill or silently fail.

## Core Abstraction

Four objects, one responsibility each:

```
Session   — append-only event log (what happened)
Harness   — drives the Claude API loop (who decides)
Registry  — tool catalogue (what can be called)
Tool      — unit of action (what gets done)
```

```python
# RunContext carries credentials and settings — never sent to Claude
@dataclass
class RunContext:
    anthropic_api_key: str
    settings: Settings
    system_code: str        # e.g. "LI-01", "OB-03"
    client_id: str
    run_id: str = field(default_factory=lambda: str(uuid4()))
```

## DRY_RUN Guard — First Line of Safety

Always gate API calls. A scheduler firing 39 jobs at noon will call the Anthropic API 39 times if this is missing.

```python
# settings.py
class Settings(BaseSettings):
    # Default TRUE — scheduler fires, tools run, but NO Claude API calls.
    # Flip to false only when ready to go live.
    dry_run: bool = True
```

```python
# harness.py — guard before the loop
async def run(self, system_prompt: str, initial_message: str, max_turns: int = 10) -> str:
    if self.ctx.settings.dry_run:
        logger.info("DRY_RUN=true — skipping Claude API call for %s", self.ctx.system_code)
        return "[dry_run] No API call made — set DRY_RUN=false to enable"

    # ... API loop follows
```

```bash
# .env — explicit is better than implicit
DRY_RUN=true    # change to false only when going live
```

## Harness — The Agent Loop

```python
class Harness:
    def __init__(self, ctx, session, registry, model=None, max_tokens=1024):
        self.ctx      = ctx
        self.session  = session
        self.registry = registry
        self.model    = model or ctx.settings.anthropic_model
        self._client  = anthropic.AsyncAnthropic(api_key=ctx.anthropic_api_key)

    async def run(self, system_prompt, initial_message, max_turns=10) -> str:
        messages = [{"role": "user", "content": initial_message}]
        tools    = self.registry.to_anthropic()

        if self.ctx.settings.dry_run:
            return "[dry_run] No API call made"

        for turn in range(max_turns):
            self.session.record_claude_request(
                messages=messages,
                system_prompt_hash=hashlib.sha256(system_prompt.encode()).hexdigest()[:16],
                model=self.model,
                max_tokens=self.max_tokens,
            )

            try:
                response = await self._client.messages.create(
                    model=self.model, max_tokens=self.max_tokens,
                    system=system_prompt, tools=tools, messages=messages,
                )
            except anthropic.APIError as exc:
                self.session.error("anthropic_api_error", str(exc))
                raise DeadLetterError(f"Anthropic API error: {exc}") from exc

            self.session.record_claude_response(
                stop_reason=response.stop_reason,
                input_tokens=response.usage.input_tokens,
                output_tokens=response.usage.output_tokens,
                tool_calls=[b.name for b in response.content if b.type == "tool_use"],
            )

            messages.append({"role": "assistant", "content": response.content})

            if response.stop_reason == "end_turn":
                return "\n".join(b.text for b in response.content if hasattr(b, "text"))

            if response.stop_reason != "tool_use":
                raise DeadLetterError(f"Unexpected stop_reason: {response.stop_reason}")

            # Execute all tool calls
            tool_results = []
            for block in response.content:
                if block.type != "tool_use":
                    continue
                tool   = self.registry.get(block.name)
                result = await self._execute_tool(tool, block)
                tool_results.append(result.to_anthropic())

            messages.append({"role": "user", "content": tool_results})

        raise DeadLetterError(f"Reached max_turns={max_turns} without end_turn")
```

## Tool Registry

```python
# Define a tool
@dataclass
class Tool:
    name: str
    description: str
    input_schema: dict          # JSON Schema for the input parameters
    fn: Callable                # async (ctx: RunContext, **kwargs) -> Any

# Register tools
class ToolRegistry:
    def __init__(self):
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool):
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def to_anthropic(self) -> list[dict]:
        return [
            {"name": t.name, "description": t.description, "input_schema": t.input_schema}
            for t in self._tools.values()
        ]

# Example tool
async def fetch_profile(ctx: RunContext, profile_url: str) -> dict:
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{ctx.settings.linkedin_mcp_url}/api/profile",
                                params={"url": profile_url})
    return resp.json()

registry.register(Tool(
    name="fetch_profile",
    description="Fetch a LinkedIn profile by URL",
    input_schema={"type": "object", "properties": {"profile_url": {"type": "string"}}, "required": ["profile_url"]},
    fn=fetch_profile,
))
```

## Session — Observability Log

```python
class Session:
    """Append-only event log. Persisted to Postgres and/or ClickHouse."""

    def record_claude_request(self, messages, system_prompt_hash, model, max_tokens):
        self._append("claude_request", {
            "message_count": len(messages),
            "system_prompt_hash": system_prompt_hash,
            "model": model, "max_tokens": max_tokens,
        })

    def record_claude_response(self, stop_reason, input_tokens, output_tokens, tool_calls):
        self._append("claude_response", {
            "stop_reason": stop_reason,
            "input_tokens": input_tokens, "output_tokens": output_tokens,
            "tool_calls": tool_calls,
        })

    def record_tool_call(self, name: str, input: dict) -> str:
        call_id = str(uuid4())
        self._append("tool_call", {"call_id": call_id, "tool": name, "input": input})
        return call_id

    def record_tool_result(self, call_id, name, output, error=None):
        self._append("tool_result", {
            "call_id": call_id, "tool": name,
            "output": str(output)[:2000] if output else None, "error": error,
        })

    def error(self, code: str, message: str):
        self._append("error", {"code": code, "message": message})
```

## APScheduler Integration

```python
from apscheduler.schedulers.asyncio import AsyncIOScheduler

scheduler = AsyncIOScheduler(timezone="UTC")

def register_system(cron: str, system_code: str, fn: Callable):
    """Register a system on a cron schedule."""
    scheduler.add_job(
        fn,
        trigger=CronTrigger.from_crontab(cron),
        id=system_code,
        replace_existing=True,
        misfire_grace_time=300,   # tolerate up to 5 min late fire
    )

# Register all 39 systems
register_system("0 9 * * 1-5", "LI-01", run_li_01)
register_system("0 7 * * *",   "OB-01", run_ob_01)
# ...

scheduler.start()
```

```python
# Each system entry point follows the same shape
async def run_li_01():
    ctx     = RunContext(...)
    session = Session(system_code="LI-01", run_id=str(uuid4()))
    harness = Harness(ctx=ctx, session=session, registry=LI_REGISTRY)
    try:
        result = await harness.run(SYSTEM_PROMPT, build_initial_message())
        logger.info("LI-01 completed: %s", result[:100])
    except DeadLetterError as exc:
        logger.error("LI-01 dead-letter: %s", exc)
        # alert Slack, write to dead_letter table
```

## Error Hierarchy

```python
class AgentError(Exception):     pass        # base
class ToolError(AgentError):     pass        # recoverable — returned to Claude as tool error
class ValidationError(AgentError): pass      # bad input — raise before calling Claude
class DeadLetterError(AgentError): pass      # unrecoverable — log, alert, stop
```

**Rule:** `ToolError` is returned to Claude as a tool result with `is_error=True` — Claude can recover. `DeadLetterError` exits the loop — triggers Slack alert and dead-letter DB write.

## Tool Execution with Error Wrapping

```python
async def _execute_tool(self, tool, block) -> ToolResult:
    if tool is None:
        return ToolResult(tool_use_id=block.id, tool_name=block.name,
                          content=f"Unknown tool: {block.name}", is_error=True)

    call_id = self.session.record_tool_call(block.name, block.input or {})
    try:
        raw_input = parse_tool_input(block.input)
        output    = await tool.fn(self.ctx, **raw_input)
        self.session.record_tool_result(call_id, block.name, output)
        return ToolResult(tool_use_id=block.id, tool_name=block.name, content=str(output))
    except ToolError as exc:
        self.session.record_tool_result(call_id, block.name, None, error=str(exc))
        return ToolResult(tool_use_id=block.id, tool_name=block.name,
                          content=str(exc), is_error=True)
    except Exception as exc:
        self.session.record_tool_result(call_id, block.name, None, error=str(exc))
        return ToolResult(tool_use_id=block.id, tool_name=block.name,
                          content=f"Tool error: {exc}", is_error=True)
```

## Safety Checklist

- [ ] `DRY_RUN=true` is the default in both `settings.py` and `.env` — flip explicitly to go live
- [ ] Scheduler `misfire_grace_time` set — prevents pile-up if server restarts during scheduled window
- [ ] `DeadLetterError` wired to Slack alert + dead_letter DB table
- [ ] `ToolError` (recoverable) distinct from `DeadLetterError` (unrecoverable)
- [ ] `system_prompt_hash` recorded per run — enables prompt-change auditing
- [ ] `max_turns` guard prevents infinite loops on pathological Claude responses
- [ ] `record_tool_call` before execution — captures intent even if the tool crashes
- [ ] API key never appears in `messages` array — stays in `RunContext` only
- [ ] `pm2 stop <agent>` confirmed before editing `.env` — no live calls during changes
