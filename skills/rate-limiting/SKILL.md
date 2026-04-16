---
name: rate-limiting
description: Rate limiting fragments — nginx request throttling, iptables connection rate rules, fail2ban threshold tuning, and per-IP burst control for API and web services
keywords: ["rate", "limiting", "ip", "api", "fragments", "nginx", "request", "throttling", "iptables", "connection", "rules", "fail2ban", "threshold", "tuning", "per-ip", "burst", "control"]
orb_class: trojan
---

# rate-limiting

Configuration fragments for rate limiting at the network and application layers. These are composable patterns — pick the layer that fits your architecture.

## Nginx — Request Rate Limiting

```nginx
# nginx.conf or /etc/nginx/conf.d/rate-limit.conf

# Define zones in http block
http {
    # 10MB zone = ~160,000 IP addresses tracked
    limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
    limit_req_zone $binary_remote_addr zone=login:10m rate=5r/m;
    limit_req_zone $http_x_forwarded_for zone=api_proxy:10m rate=10r/s;

    # Response on limit exceeded
    limit_req_status 429;
}
```

```nginx
# server block — apply zones to routes
server {
    location /api/ {
        limit_req zone=api burst=20 nodelay;
        # burst=20: allows up to 20 queued requests above rate
        # nodelay: process burst immediately (no queuing delay)
        proxy_pass http://127.0.0.1:9002;
    }

    location /api/auth/login {
        limit_req zone=login burst=3 nodelay;
        proxy_pass http://127.0.0.1:9002;
    }

    # Add Retry-After header to 429 responses
    add_header Retry-After 60 always;
}
```

## Nginx — Connection Limiting

```nginx
http {
    # Track concurrent connections per IP
    limit_conn_zone $binary_remote_addr zone=conn_limit:10m;
    limit_conn_status 429;
}

server {
    location / {
        limit_conn conn_limit 20;    # max 20 concurrent connections per IP
        proxy_pass http://127.0.0.1:8080;
    }
}
```

## iptables — Connection Rate Rules

```bash
# Limit new SSH connections: max 3 per minute per IP
iptables -A INPUT -p tcp --dport 22 -m state --state NEW \
  -m recent --set --name SSH
iptables -A INPUT -p tcp --dport 22 -m state --state NEW \
  -m recent --update --seconds 60 --hitcount 4 --name SSH -j DROP

# Limit new HTTP connections per IP (protect against slow-loris)
iptables -A INPUT -p tcp --dport 80 -m state --state NEW \
  -m limit --limit 50/min --limit-burst 100 -j ACCEPT
iptables -A INPUT -p tcp --dport 80 -m state --state NEW -j DROP

# Log before dropping (for monitoring)
iptables -A INPUT -p tcp --dport 80 -m state --state NEW \
  -m limit --limit 50/min --limit-burst 100 -j ACCEPT
iptables -A INPUT -p tcp --dport 80 \
  -j LOG --log-prefix "RATE-LIMIT-DROP: "
iptables -A INPUT -p tcp --dport 80 -j DROP
```

## fail2ban — Threshold Tuning

```ini
# /etc/fail2ban/jail.local

[DEFAULT]
bantime  = 1h        # ban duration
findtime = 10m       # window for counting failures
maxretry = 5         # failures before ban

# Repeat offenders get longer bans (requires fail2ban 0.11+)
bantime.increment   = true
bantime.multiplier  = 2      # 1h → 2h → 4h → 8h ...
bantime.maxtime     = 24h

[nginx-req-limit]
# Ban IPs triggering nginx 429 responses
enabled  = true
port     = http,https
logpath  = /var/log/nginx/error.log
failregex = limiting requests, excess: .* by zone .*, client: <HOST>
maxretry = 10
findtime = 1m
bantime  = 30m

[api-auth-fail]
# Custom jail for application-level 401/403
enabled  = true
port     = http,https
logpath  = /var/log/myapp/api.log
failregex = .*"status":40[13].*"ip":"<HOST>"
maxretry = 10
findtime = 5m
bantime  = 2h
```

## API Rate Limit Headers

Always return rate limit state to well-behaved clients.

```python
# FastAPI — rate limit response headers
from fastapi import Response

@app.middleware("http")
async def add_rate_limit_headers(request: Request, call_next):
    response = await call_next(request)
    # Populate from your rate limiter (redis, in-memory, etc.)
    response.headers["X-RateLimit-Limit"]     = "100"
    response.headers["X-RateLimit-Remaining"] = str(remaining)
    response.headers["X-RateLimit-Reset"]     = str(reset_epoch)
    if remaining == 0:
        response.headers["Retry-After"] = str(retry_after_seconds)
    return response
```

## Checklist

- [ ] `limit_req_zone` defined in `http {}` block, not `server {}` or `location {}`
- [ ] `burst` value set — without it, any spike above `rate` returns 429 immediately
- [ ] `limit_req_status 429` set — default is 503 which is misleading
- [ ] `Retry-After` header returned on 429 responses
- [ ] fail2ban `nginx-req-limit` jail enabled to escalate persistent violators to IP ban
- [ ] Rate limit zones sized correctly for expected unique-IP volume (10m ≈ 160k IPs)
