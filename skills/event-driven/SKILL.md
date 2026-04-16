---
name: event-driven
description: Event-driven architecture authority — Redis pub/sub, event bus patterns, async event pipelines, channel management, startup recovery, dead-letter handling, and reactive system design
---

# event-driven

Covers how to design, implement, and operate event-driven systems: pub/sub messaging, event buses, async pipelines, and reactive coordination between services.

## 1) Redis pub/sub fundamentals

```python
import redis.asyncio as aioredis
import asyncio, json

redis = aioredis.from_url("redis://localhost:6379", decode_responses=True)

# Publisher
async def publish(channel: str, event: dict):
    await redis.publish(channel, json.dumps({**event, "_ts": asyncio.get_event_loop().time()}))

# Subscriber (persistent listener)
async def subscribe(channels: list[str], handler):
    async with redis.pubsub() as pubsub:
        await pubsub.subscribe(*channels)
        async for message in pubsub.listen():
            if message["type"] == "message":
                await handler(json.loads(message["data"]))
```

## 2) Event bus abstraction

```python
from collections import defaultdict
from typing import Callable, Awaitable

EventHandler = Callable[[dict], Awaitable[None]]

class EventBus:
    def __init__(self):
        self._handlers: dict[str, list[EventHandler]] = defaultdict(list)

    def on(self, event_type: str):
        """Decorator to register a handler."""
        def decorator(fn: EventHandler) -> EventHandler:
            self._handlers[event_type].append(fn)
            return fn
        return decorator

    async def emit(self, event_type: str, payload: dict):
        for handler in self._handlers.get(event_type, []):
            await handler({"type": event_type, **payload})

    async def emit_all(self, events: list[tuple[str, dict]]):
        """Emit multiple events concurrently."""
        await asyncio.gather(*[self.emit(t, p) for t, p in events])

bus = EventBus()

@bus.on("article.published")
async def on_article_published(event: dict):
    await index_article(event["slug"])

@bus.on("article.published")
async def notify_subscribers(event: dict):
    await send_notification(event["slug"])
```

## 3) Durable event queue (Redis Streams)

```python
# Redis Streams — persistent, replayable, consumer-group aware
async def stream_publish(stream: str, event: dict) -> str:
    """Append event to stream, returns message ID."""
    return await redis.xadd(stream, event)

async def stream_consume(stream: str, group: str, consumer: str, count: int = 10):
    """Read new messages from consumer group."""
    try:
        await redis.xgroup_create(stream, group, id="0", mkstream=True)
    except Exception:
        pass  # group already exists
    messages = await redis.xreadgroup(group, consumer, {stream: ">"}, count=count, block=5000)
    return [(msg_id, data) for _, msgs in (messages or []) for msg_id, data in msgs]

async def stream_ack(stream: str, group: str, *msg_ids: str):
    await redis.xack(stream, group, *msg_ids)

# Usage
async def worker_loop(stream: str, group: str, consumer_id: str):
    while True:
        for msg_id, data in await stream_consume(stream, group, consumer_id):
            try:
                await process_event(data)
                await stream_ack(stream, group, msg_id)
            except Exception as e:
                await move_to_dlq(stream, msg_id, data, str(e))
```

## 4) Dead-letter queue (DLQ)

```python
DLQ_KEY = "dlq:{stream}"
MAX_RETRIES = 3

async def move_to_dlq(stream: str, msg_id: str, data: dict, error: str):
    dlq = DLQ_KEY.format(stream=stream)
    entry = {**data, "_error": error, "_msg_id": msg_id, "_failed_at": str(asyncio.get_event_loop().time())}
    await redis.lpush(dlq, json.dumps(entry))
    await redis.expire(dlq, 86400 * 7)  # keep 7 days

async def replay_dlq(stream: str, limit: int = 100) -> int:
    """Requeue DLQ messages back to the original stream."""
    dlq = DLQ_KEY.format(stream=stream)
    replayed = 0
    while replayed < limit:
        raw = await redis.rpop(dlq)
        if not raw:
            break
        data = json.loads(raw)
        # Strip error metadata before replaying
        clean = {k: v for k, v in data.items() if not k.startswith("_")}
        await stream_publish(stream, clean)
        replayed += 1
    return replayed
```

## 5) Startup recovery (process pending messages)

```python
async def recover_pending(stream: str, group: str, consumer: str, idle_ms: int = 30_000):
    """Claim messages that were delivered but never acknowledged (e.g. after crash)."""
    pending = await redis.xpending_range(stream, group, min="-", max="+", count=100)
    recovered = 0
    for entry in pending:
        if entry["time_since_delivered"] >= idle_ms:
            claimed = await redis.xclaim(stream, group, consumer, idle_ms, [entry["message_id"]])
            for msg_id, data in claimed:
                try:
                    await process_event(data)
                    await stream_ack(stream, group, msg_id)
                    recovered += 1
                except Exception as e:
                    await move_to_dlq(stream, msg_id, data, str(e))
    return recovered
```

## 6) Channel management and namespacing

```python
# Channel naming convention: {domain}.{entity}.{action}
CHANNELS = {
    "articles":    "content.article.*",     # wildcard with psubscribe
    "seo_jobs":    "seo.job.queued",
    "agent_tasks": "agent.task.assigned",
    "analytics":   "analytics.event.tracked",
}

# Pattern subscriptions (Redis PSUBSCRIBE)
async def subscribe_pattern(pattern: str, handler):
    async with redis.pubsub() as pubsub:
        await pubsub.psubscribe(pattern)
        async for message in pubsub.listen():
            if message["type"] == "pmessage":
                await handler(message["channel"], json.loads(message["data"]))

# Event schema validation
from pydantic import BaseModel

class ArticleEvent(BaseModel):
    slug: str
    domain: str
    action: str   # published | updated | deleted
    triggered_by: str

async def publish_article_event(slug: str, domain: str, action: str):
    event = ArticleEvent(slug=slug, domain=domain, action=action, triggered_by="system")
    await publish(f"content.article.{action}", event.model_dump())
```

## 7) FastAPI integration

```python
from fastapi import FastAPI
from contextlib import asynccontextmanager

bus = EventBus()

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Start background event listener on startup
    task = asyncio.create_task(
        subscribe(["content.article.*"], handle_article_event)
    )
    yield
    task.cancel()

app = FastAPI(lifespan=lifespan)

@app.post("/articles/{slug}/publish")
async def publish_article(slug: str):
    # ... save to DB ...
    await bus.emit("article.published", {"slug": slug})
    await publish("content.article.published", {"slug": slug})
    return {"status": "ok"}
```

## 8) Checklist — event-driven system

- [ ] Channels follow `{domain}.{entity}.{action}` naming convention
- [ ] All events have `_ts` timestamp and schema validation (Pydantic)
- [ ] Durable events use Redis Streams (not plain pub/sub) for persistence
- [ ] Consumer groups created with `mkstream=True` (idempotent startup)
- [ ] Startup recovery handles pending/unacked messages from prior crash
- [ ] Dead-letter queue captures failed messages with error context
- [ ] DLQ has TTL set (7 days) — stale failures don't accumulate forever
- [ ] Pattern subscriptions (`psubscribe`) used for wildcard channel listening
- [ ] Event bus handlers are independently testable (pass mock payloads)
- [ ] Background listener started in FastAPI lifespan context (not on startup hook)
