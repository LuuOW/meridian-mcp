---
name: background-tasks
description: Async task execution authority — Celery workers and beat scheduler, APScheduler in-process cron, bare Redis LPUSH/BRPOP queues, dead-letter queues, idempotency patterns, task monitoring, and Docker Compose worker definitions for Python pipelines
keywords: ["background", "tasks", "async", "celery", "apscheduler", "redis", "lpush", "brpop", "docker", "compose", "python", "task", "queues", "execution", "authority", "workers", "beat", "scheduler", "in-process", "cron"]
orb_class: trojan
---

# background-tasks

Covers async task execution: Celery + beat for scheduled/queued work, APScheduler for in-process cron, and bare Redis queues for lightweight pipelines.

## 1) Celery setup (Python)

```python
# celery_app.py
from celery import Celery

celery = Celery(
    "tasks",
    broker="redis://localhost:6379/1",    # DB 1 for queues (never evicted)
    backend="redis://localhost:6379/2",   # DB 2 for results
    include=["app.tasks"],
)

celery.conf.update(
    task_serializer="json",
    result_expires=3600,
    timezone="UTC",
    enable_utc=True,
    worker_prefetch_multiplier=1,   # process one task at a time (prevents memory spike)
    task_acks_late=True,            # ack after success, not on receive (safe retry on crash)
)
```

## 2) Defining tasks

```python
from celery_app import celery

@celery.task(bind=True, max_retries=3, default_retry_delay=60)
def generate_article(self, domain: str, slug: str) -> dict:
    try:
        result = run_pipeline(domain, slug)
        return result
    except TemporaryError as exc:
        raise self.retry(exc=exc)     # exponential back-off via default_retry_delay
    except PermanentError:
        # Don't retry — log and fail cleanly
        logger.error("permanent_failure", domain=domain, slug=slug)
        return {"status": "failed"}

# Enqueue
task = generate_article.delay(domain="keto", slug="keto-diet-guide")
print(task.id)            # track this ID
```

## 3) Celery Beat (scheduled tasks)

```python
from celery.schedules import crontab

celery.conf.beat_schedule = {
    "serp-delta-check": {
        "task":     "app.tasks.run_serp_delta",
        "schedule": crontab(hour="*/6"),      # every 6h
    },
    "link-score-refresh": {
        "task":     "app.tasks.refresh_link_scores",
        "schedule": crontab(hour=3, minute=0),  # 3am UTC
    },
}
```

## 4) Docker Compose: worker + beat

```yaml
services:
  worker-default:
    build: .
    command: celery -A celery_app worker -Q default -c 2 --loglevel=info
    environment:
      - REDIS_URL=redis://redis:6379/1
    depends_on: [redis]
    restart: unless-stopped

  worker-scraping:
    build: .
    command: celery -A celery_app worker -Q scraping -c 1 --loglevel=info
    depends_on: [redis]
    restart: unless-stopped

  beat:
    build: .
    command: celery -A celery_app beat --loglevel=info --scheduler celery.beat.PersistentScheduler
    depends_on: [redis]
    restart: unless-stopped
```

## 5) APScheduler (in-process, no Redis needed)

```python
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

scheduler = AsyncIOScheduler(timezone="UTC")

@scheduler.scheduled_job(CronTrigger(hour="*/4"))
async def refresh_serp():
    await run_serp_delta()

@scheduler.scheduled_job("interval", minutes=15)
async def heartbeat():
    await redis.set("heartbeat", time.time(), ex=60)

# Start with FastAPI lifespan
@asynccontextmanager
async def lifespan(app: FastAPI):
    scheduler.start()
    yield
    scheduler.shutdown()

app = FastAPI(lifespan=lifespan)
```

## 6) Idempotency pattern (safe retries)

```python
async def process_once(job_id: str, fn, *args):
    """Run fn only if job_id hasn't been successfully processed."""
    lock_key = f"job:done:{job_id}"
    if await redis.exists(lock_key):
        return  # already processed

    result = await fn(*args)

    await redis.set(lock_key, "1", ex=86400)   # remember for 24h
    return result

# Usage in Celery task
@celery.task
def publish_article(slug: str):
    asyncio.run(process_once(f"publish:{slug}", do_publish, slug))
```

## 7) Task monitoring

```bash
# Celery — active/reserved/scheduled tasks
celery -A celery_app inspect active
celery -A celery_app inspect reserved
celery -A celery_app inspect scheduled

# Queue depth (Redis)
redis-cli -n 1 llen celery          # default queue length
redis-cli -n 1 llen scraping        # scraping queue length

# Worker stats
celery -A celery_app inspect stats

# Flower (web UI for Celery — optional)
celery -A celery_app flower --port=5555
```

## 8) Bare Redis queue (no Celery, lightweight)

```python
QUEUE = "jobs:enrich"

# Producer
async def enqueue(job: dict):
    await redis.lpush(QUEUE, json.dumps(job))

# Consumer (runs in asyncio loop)
async def consume():
    while True:
        raw = await redis.brpop(QUEUE, timeout=5)
        if raw:
            job = json.loads(raw[1])
            await handle(job)

# Start consumer as background task (FastAPI)
@asynccontextmanager
async def lifespan(app):
    asyncio.create_task(consume())
    yield
```

## 9) Dead-letter queue pattern

```python
DLQ = "jobs:dead"

async def safe_handle(job: dict):
    try:
        await handle(job)
    except Exception as e:
        # Move to DLQ with error metadata
        await redis.lpush(DLQ, json.dumps({**job, "_error": str(e), "_ts": time.time()}))
        log.error("job_failed", job=job, error=str(e))

# Inspect dead letters
redis-cli -n 1 lrange jobs:dead 0 -1
```

## 10) Checklist

- [ ] `task_acks_late=True` — ack after success, not on delivery (prevents lost tasks on worker crash)
- [ ] `worker_prefetch_multiplier=1` — prevents memory spikes from prefetching long tasks
- [ ] Job queue Redis DB has `noeviction` policy (never evict queued jobs)
- [ ] All tasks are idempotent — safe to retry without side effects
- [ ] Beat scheduler uses `PersistentScheduler` — survives restarts
- [ ] Workers and beat have `restart: unless-stopped` in compose
- [ ] Dead-letter queue for failed jobs — inspect instead of silent drops
- [ ] Queue depth monitored — alert if `llen` > threshold
