---
name: webhook
description: Webhook receiver patterns — HMAC signature verification, idempotency, retry handling, delivery guarantees, dead-letter logging, and local testing with ngrok or smee
keywords: ["webhook", "hmac", "receiver", "patterns", "signature", "verification", "idempotency", "retry", "handling", "delivery", "guarantees", "dead-letter", "logging", "local", "testing"]
orb_class: moon
---

# webhook

Production patterns for receiving and sending webhooks. Covers security verification, idempotency, queue-backed processing, and local development tunnels. Language-agnostic with FastAPI and Express examples.

## 1) HMAC Signature Verification

Never process a webhook without verifying the signature. Reject before parsing the body.

```python
# FastAPI — generic HMAC-SHA256
import hashlib, hmac, time
from fastapi import APIRouter, Request, HTTPException

router = APIRouter()

def verify_hmac(body: bytes, signature: str, secret: str, prefix: str = "sha256=") -> bool:
    expected = prefix + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected.encode(), signature.encode())

@router.post("/webhooks/github")
async def github_webhook(request: Request):
    body = await request.body()
    sig = request.headers.get("X-Hub-Signature-256", "")
    if not verify_hmac(body, sig, secret=settings.GITHUB_WEBHOOK_SECRET):
        raise HTTPException(status_code=401, detail="Invalid signature")
    payload = await request.json()
    # ... process
```

```ts
// Express — Stripe signature verification
import Stripe from 'stripe';

app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature']!;
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }
  // process event...
  res.json({ received: true });
});
```

## 2) Replay Attack Guard (Timestamp Check)

```python
# Slack, GitHub, and Stripe all include timestamps
def verify_slack(body: bytes, timestamp: str, signature: str, secret: str) -> bool:
    if abs(time.time() - int(timestamp)) > 300:   # reject if >5 min old
        return False
    base = f"v0:{timestamp}:{body.decode()}"
    expected = "v0=" + hmac.new(secret.encode(), base.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
```

## 3) Idempotency

Webhook providers retry on non-2xx. Process each delivery exactly once.

```python
# Store delivery IDs in Redis or DB
from core.redis import get_redis

@router.post("/webhooks/github")
async def github_webhook(request: Request):
    delivery_id = request.headers.get("X-GitHub-Delivery", "")
    redis = await get_redis()

    # Deduplicate
    key = f"webhook:seen:{delivery_id}"
    if await redis.exists(key):
        return {"ok": True, "skipped": True}   # already processed
    await redis.set(key, "1", ex=86400)         # remember for 24h

    # Process
    payload = await request.json()
    await process_payload(payload)
    return {"ok": True}
```

## 4) Queue-Backed Processing (Async)

Return 200 immediately, process in background. Never do slow work inline.

```python
# FastAPI + background task queue (Celery / RQ / ARQ)
from fastapi import BackgroundTasks

@router.post("/webhooks/github")
async def github_webhook(request: Request, background_tasks: BackgroundTasks):
    body = await request.body()
    # ... verify signature
    payload = await request.json()

    # Acknowledge immediately, process async
    background_tasks.add_task(handle_github_event, payload)
    return {"ok": True}

async def handle_github_event(payload: dict):
    event = payload.get("action")
    if event == "opened":
        await handle_pr_opened(payload)
    # ... other handlers
```

## 5) Dead-Letter Logging

Log every unprocessable webhook — never silently swallow them.

```python
@router.post("/webhooks/github")
async def github_webhook(request: Request):
    body = await request.body()
    try:
        # verify + process
        ...
    except Exception as exc:
        # Log raw body for replay
        logger.error(
            "webhook_processing_failed",
            extra={
                "delivery_id": request.headers.get("X-GitHub-Delivery"),
                "error": str(exc),
                "raw_body": body[:2048].decode(errors="replace"),
            }
        )
        # Still return 200 to stop provider from retrying a broken payload
        return {"ok": False, "error": "processing failed — logged for review"}
```

## 6) Sending Webhooks (Outbound)

```python
import httpx

async def send_webhook(url: str, payload: dict, secret: str) -> bool:
    body = json.dumps(payload).encode()
    sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()

    async with httpx.AsyncClient(timeout=10) as client:
        for attempt in range(3):
            try:
                resp = await client.post(
                    url,
                    content=body,
                    headers={
                        "Content-Type": "application/json",
                        "X-Webhook-Signature": sig,
                        "X-Delivery-Id": str(uuid4()),
                    },
                )
                if resp.status_code < 300:
                    return True
            except httpx.RequestError:
                pass
            await asyncio.sleep(2 ** attempt)   # exponential backoff: 1s, 2s, 4s
    return False
```

## 7) Local Development Tunnels

```bash
# ngrok — HTTPS tunnel to localhost
ngrok http 8000
# Use the https://xxxxx.ngrok.io URL as webhook endpoint in provider dashboard

# smee.io — lightweight, no auth needed (good for CI)
npm install -g smee-client
smee --url https://smee.io/your-channel-id --path /webhooks/github --port 8000

# Cloudflare Tunnel (persistent, no account needed for quick test)
cloudflared tunnel --url http://localhost:8000
```

## 8) Checklist

- [ ] HMAC signature verified before body is parsed
- [ ] Timestamp checked — reject payloads older than 5 minutes
- [ ] Delivery ID stored for deduplication
- [ ] Processing is async — 200 returned within 1s
- [ ] Dead-letter log captures raw body for all failures
- [ ] Outbound webhooks use exponential backoff (3 retries max)
- [ ] Webhook secret rotated on any personnel change
- [ ] ngrok / smee used in development — never expose local port directly
