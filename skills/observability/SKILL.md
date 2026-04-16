---
name: observability
description: Structured logging (structlog/Python, pino/Node), health endpoints, PM2 and Docker metrics, alerting patterns
---

# observability

Covers the three pillars — logs, metrics, and traces — with practical patterns for the Python/FastAPI + Node/PM2 + Docker stack.

## 1) Structured logging with structlog (Python)

```python
import structlog

structlog.configure(
    processors=[
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.JSONRenderer(),   # machine-parseable
    ],
    wrapper_class=structlog.stdlib.BoundLogger,
    context_class=dict,
    logger_factory=structlog.PrintLoggerFactory(),
)

log = structlog.get_logger()

# Bind context to a request
log = log.bind(request_id=req_id, domain=domain)
log.info("article_generated", word_count=1200, model="gpt-4o")
log.error("llm_timeout", retries=3, elapsed_ms=15000)
```

## 2) Structured logging in Node.js

```js
// Minimal structured logger (no deps)
const log = (level, msg, ctx = {}) =>
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...ctx }) + '\n');

log('info',  'server_start', { port: 4401 });
log('error', 'cache_miss',   { key: 'status', latency_ms: 4500 });
```

## 3) FastAPI health endpoints

```python
from fastapi import APIRouter
import psutil, time

router = APIRouter()
START = time.time()

@router.get("/health")
async def health():
    return {"status": "ok"}

@router.get("/health/ready")
async def ready(db: AsyncSession = Depends(get_db)):
    # Check every hard dependency
    try:
        await db.execute(text("SELECT 1"))
    except Exception as e:
        raise HTTPException(503, detail=f"db: {e}")
    return {"status": "ready", "uptime_s": round(time.time() - START)}

@router.get("/health/metrics")
async def metrics():
    return {
        "cpu_pct":    psutil.cpu_percent(interval=0.1),
        "mem_pct":    psutil.virtual_memory().percent,
        "disk_pct":   psutil.disk_usage("/").percent,
        "uptime_s":   round(time.time() - START),
    }
```

## 4) Docker health checks (in compose)

```yaml
services:
  api:
    image: my-api
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s   # grace period at container start
```

```bash
# Check health status
docker inspect --format='{{.State.Health.Status}}' container_name
docker inspect --format='{{json .State.Health}}' container_name | python3 -m json.tool
```

## 5) PM2 metrics & log management

```bash
# Real-time dashboard
pm2 monit

# Status snapshot
pm2 status
pm2 info <app-name>

# Logs (tail / rotate)
pm2 logs <app-name> --lines 50
pm2 flush          # clear all logs
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7

# Memory alert — restart if over threshold (set in ecosystem.config.cjs)
max_memory_restart: '200M'
```

## 6) Docker stats snapshot

```bash
# One-shot stats (no stream — good for cron/scripts)
docker stats --no-stream --format \
  "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}"

# Last N log lines from all containers
for c in $(docker ps --format '{{.Names}}'); do
  echo "=== $c ==="; docker logs --tail 10 "$c" 2>&1; done
```

## 7) Log aggregation pattern (no external service)

```bash
# Collect PM2 + Docker logs into a daily file
LOG_DIR=/var/log/vps-daily
mkdir -p $LOG_DIR
DATE=$(date +%F)

pm2 logs --nostream --lines 200 2>&1 >> "$LOG_DIR/pm2-$DATE.log"
docker stats --no-stream >> "$LOG_DIR/docker-stats-$DATE.log"

# Cron: run daily at 23:55
55 23 * * * /root/scripts/collect-logs.sh
```

## 8) Alert patterns (webhook / simple script)

```python
import httpx, os

SLACK_WEBHOOK = os.getenv("SLACK_WEBHOOK_URL")

async def alert(msg: str, level: str = "warning"):
    if not SLACK_WEBHOOK:
        return
    emoji = {"warning": "⚠️", "error": "🔴", "info": "ℹ️"}.get(level, "📢")
    await httpx.AsyncClient().post(SLACK_WEBHOOK, json={"text": f"{emoji} *{level.upper()}*: {msg}"})

# Usage
if cpu_pct > 90:
    await alert(f"CPU at {cpu_pct}% on srv1383611", level="warning")
```

## 9) Key metrics to track per project

| Metric | Where to get it | Alert threshold |
|--------|----------------|-----------------|
| Container CPU % | `docker stats` | > 80% sustained |
| Container mem % | `docker stats` | > 85% |
| PM2 restart count | `pm2 status` | > 5 restarts/hr |
| API p99 latency | app logs | > 2s |
| DB connections | `pg_stat_activity` | > 80% pool |
| Disk usage | `df -h` | > 85% |
| Redis memory | `redis-cli info memory` | > 70% maxmemory |

## 10) Checklist

- [ ] Every service exposes `/health` (liveness) and `/health/ready` (readiness)
- [ ] Docker `healthcheck` defined in compose for all API containers
- [ ] Logs are structured JSON (not plain text) — easier to grep/parse
- [ ] PM2 logrotate installed and configured
- [ ] `pool_pre_ping=True` on DB engine (silent connection errors hidden without it)
- [ ] Alert on restart loops (> 3 restarts in 10 min)
- [ ] `docker stats --no-stream` in cron for daily snapshots
