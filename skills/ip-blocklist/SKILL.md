---
name: ip-blocklist
description: IP allowlist and blocklist fragments — iptables/nftables set-based blocking, nginx geo blocks, Cloudflare IP rules, and dynamic blocklist management for network access control
keywords: ["blocklist", "ip", "cloudflare", "allowlist", "fragments", "iptables/nftables", "set-based", "blocking", "nginx", "geo", "blocks", "rules", "dynamic", "management", "network", "access"]
orb_class: trojan
---

# ip-blocklist

Fragments for IP-based access control. Use these patterns to restrict or block traffic at the network or proxy layer. Composable with firewall and rate-limiting skills.

## iptables — Static Block/Allow

```bash
# Block a single IP
iptables -A INPUT -s 203.0.113.42 -j DROP

# Block a CIDR range
iptables -A INPUT -s 198.51.100.0/24 -j DROP

# Allow only specific IPs to a port (allowlist pattern)
iptables -A INPUT -p tcp --dport 5432 -s 10.8.0.0/24 -j ACCEPT
iptables -A INPUT -p tcp --dport 5432 -j DROP           # drop all others

# Log before dropping (for audit trail)
iptables -A INPUT -s 203.0.113.42 -j LOG --log-prefix "BLOCKED-IP: "
iptables -A INPUT -s 203.0.113.42 -j DROP

# Persist
iptables-save > /etc/iptables/rules.v4
```

## nftables — Dynamic Set-Based Blocklist

```nft
# /etc/nftables.conf — define a set, populate it dynamically

table inet filter {
  set blocklist {
    type ipv4_addr
    flags interval, timeout      # timeout: entries auto-expire
    timeout 24h                  # auto-remove after 24h
  }

  set allowlist {
    type ipv4_addr
    flags interval
    elements = { 10.8.0.0/24, 203.0.113.0/24 }  # static admin ranges
  }

  chain input {
    type filter hook input priority 0; policy drop;
    ip saddr @blocklist drop
    ip saddr @allowlist accept
    # ... other rules
  }
}
```

```bash
# Add to blocklist at runtime (no reload needed)
nft add element inet filter blocklist { 198.51.100.42 }
nft add element inet filter blocklist { 192.0.2.0/24 }

# Remove from blocklist
nft delete element inet filter blocklist { 198.51.100.42 }

# Inspect current set contents
nft list set inet filter blocklist
```

## nginx — Geo-Based Access Control

```nginx
# nginx.conf — http block
http {
    # Allowlist: only listed IPs allowed
    geo $allowed_ip {
        default         0;             # deny by default
        10.8.0.0/24     1;             # VPN subnet
        203.0.113.0/24  1;             # office range
        127.0.0.1       1;             # localhost
    }

    # Blocklist: listed IPs denied
    geo $blocked_ip {
        default         0;
        198.51.100.0/24 1;             # known bad range
        192.0.2.42      1;
    }
}

# server block — enforce
server {
    location /admin/ {
        if ($allowed_ip = 0) { return 403; }
        proxy_pass http://127.0.0.1:9002;
    }

    location / {
        if ($blocked_ip = 1) { return 403; }
        proxy_pass http://127.0.0.1:8080;
    }
}
```

## Dynamic Script — Ban Repeated Offenders

```bash
#!/bin/bash
# /opt/scripts/auto-block.sh — ban IPs with > 100 failed attempts in auth.log

LOG="/var/log/auth.log"
THRESHOLD=100
CHAIN="INPUT"

# Find IPs exceeding threshold
grep "Failed password" "$LOG" \
  | awk '{print $(NF-3)}' \
  | sort | uniq -c | sort -rn \
  | awk -v t="$THRESHOLD" '$1 > t {print $2}' \
  | while read ip; do
      if ! iptables -C "$CHAIN" -s "$ip" -j DROP 2>/dev/null; then
          iptables -A "$CHAIN" -s "$ip" -j DROP
          echo "$(date): Blocked $ip ($count attempts)" >> /var/log/auto-block.log
      fi
  done

iptables-save > /etc/iptables/rules.v4
```

## Cloudflare — IP Rules via API

```bash
CF_TOKEN="your-token"
CF_ZONE_ID="your-zone-id"

# Create a WAF IP block rule
curl -s -X POST \
  "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/firewall/rules" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  --data '[{
    "filter": {"expression": "ip.src eq 198.51.100.42"},
    "action": "block",
    "description": "Block known bad actor"
  }]'

# Block entire country (use with caution)
curl -s -X POST \
  "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/firewall/rules" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  --data '[{
    "filter": {"expression": "ip.geoip.country eq \"XX\""},
    "action": "challenge",
    "description": "Challenge traffic from XX"
  }]'
```

## Checklist

- [ ] Blocklist entries logged before drop — audit trail for forensics
- [ ] nftables sets use `timeout` — blocked IPs auto-expire, no stale entries
- [ ] nginx `geo` block placed in `http {}` block, not `server {}` (one definition only)
- [ ] Allowlist-based access on admin endpoints — safer than blocklist-only
- [ ] Auto-block script tested in dry-run mode before cron deployment
- [ ] `iptables-save` called after every dynamic block to survive reboot
