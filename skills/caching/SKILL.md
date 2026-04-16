---
name: caching
description: Redis patterns (pub/sub, queues, TTL), in-process caching, cache-aside strategy, invalidation, Python and Node clients
---

# caching

Covers Redis as cache, pub/sub bus, and job queue — plus lightweight in-process caching for Node/Python services.

## 1) Redis connection (Python — async)

```python
import redis.asyncio as aioredis

redis = aioredis.from_url(
    "redis://localhost:6379",
    encoding="utf-8",
    decode_responses=True,
    max_connections=20,
)

# Simple get/set with TTL
await redis.set("key", "value", ex=300)   # expires in 5 min
value = await redis.get("key")            # None if expired/missing

# Delete
await redis.delete("key")
```

## 2) Cache-aside pattern (Python)

```python
import json

async def get_article(slug: str) -> dict:
    cache_key = f"article:{slug}"

    cached = await redis.get(cache_key)
    if cached:
        return json.loads(cached)

    article = await db.fetch_article(slug)        # expensive DB read
    await redis.set(cache_key, json.dumps(article), ex=3600)
    return article

# Invalidate on write
async def update_article(slug: str, data: dict):
    await db.update_article(slug, data)
    await redis.delete(f"article:{slug}")         # bust cache
```

## 3) Pub/sub (event bus between agents)

```python
# Publisher
async def publish(channel: str, payload: dict):
    await redis.publish(channel, json.dumps(payload))

await publish("article.ready", {"slug": slug, "domain": domain})

# Subscriber (runs in background task)
async def subscribe(channel: str):
    pubsub = redis.pubsub()
    await pubsub.subscribe(channel)
    async for message in pubsub.listen():
        if message["type"] == "message":
            data = json.loads(message["data"])
            await handle_event(data)
```

## 4) Redis as job queue (simple LPUSH/BRPOP)

```python
QUEUE = "jobs:scrape"

# Enqueue
await redis.lpush(QUEUE, json.dumps({"url": url, "domain": domain}))

# Worker — blocking pop, 30s timeout
async def worker():
    while True:
        item = await redis.brpop(QUEUE, timeout=30)
        if item:
            _, raw = item
            job = json.loads(raw)
            await process(job)
```

## 5) In-process cache (Node.js — zero deps)

```js
// Simple TTL map — good for server-side rendered pages
const cache = new Map();

function setCache(key, value, ttlMs = 12_000) {
  cache.set(key, { value, exp: Date.now() + ttlMs });
}
function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) { cache.delete(key); return null; }
  return entry.value;
}

// Usage (agent-dashboard pattern)
let _cache = null;
async function refreshCache() { _cache = await gatherData(); }
setInterval(refreshCache, 12_000);
refreshCache();

// API handler responds instantly from _cache
app.get('/api/status', (req, res) => res.json(_cache));
```

## 6) Redis rate limiting (token bucket via INCR)

```python
async def check_rate_limit(key: str, limit: int, window_s: int) -> bool:
    pipe = redis.pipeline()
    pipe.incr(key)
    pipe.expire(key, window_s)
    count, _ = await pipe.execute()
    return count <= limit

# Usage
allowed = await check_rate_limit(f"rl:{ip}", limit=60, window_s=60)
if not allowed:
    raise HTTPException(429, "Rate limit exceeded")
```

## 7) Cache key conventions

```
# Pattern: service:resource_type:identifier[:variant]
article:slug:keto-diet-guide
domain:stats:ketoandhealthy.com
session:token:abc123
rl:ip:1.2.3.4
jobs:scrape
jobs:publish
```

## 8) Redis diagnostics

```bash
redis-cli info memory       # used_memory_human, maxmemory
redis-cli info stats        # keyspace_hits, keyspace_misses (hit rate)
redis-cli info keyspace     # db0: keys=N,expires=N
redis-cli dbsize            # total key count
redis-cli --latency         # round-trip latency
redis-cli keys "article:*"  # list keys by pattern (don't use on prod with millions of keys — use SCAN)
redis-cli scan 0 match "article:*" count 100
```

## 9) Eviction policy (set for cache use cases)

```bash
# In redis.conf or at runtime
redis-cli config set maxmemory 512mb
redis-cli config set maxmemory-policy allkeys-lru   # evict least-recently-used when full

# For job queues (never evict jobs): use a separate Redis DB or instance
redis-cli -n 1 lpush jobs:scrape ...   # DB 1 = queues, DB 0 = cache
```

## 10) Checklist

- [ ] All cache keys follow `service:type:id` convention
- [ ] TTL set on every `SET` call — never store without expiry on cache keys
- [ ] Cache-aside: invalidate on write, not on read
- [ ] Pub/sub channels don't overlap with queue key names
- [ ] `maxmemory` + `allkeys-lru` set for pure-cache Redis instances
- [ ] Job queue Redis instance has `noeviction` policy (never lose a job)
- [ ] In-process cache for single-process Node servers (avoids Redis round-trip for hot data)
