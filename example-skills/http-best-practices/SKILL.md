---
name: http-best-practices
description: Patterns for HTTP clients + servers — idempotency, retries, timeouts, status code semantics, and request/response tracing.
---

# http-best-practices

## Timeouts
- Always set connect timeout (≤5s) and read timeout (≤30s)
- Never trust defaults; they vary by library

## Retries
- Only retry on transient: 408, 429, 502, 503, 504, network errors
- Exponential backoff + jitter
- Respect `Retry-After` header

## Idempotency
- Use `Idempotency-Key` header for non-GET methods
- UUID per logical operation, not per HTTP attempt
