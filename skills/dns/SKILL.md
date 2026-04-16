---
name: dns
description: DNS record management, Cloudflare API automation, TTL strategy, Let's Encrypt DNS challenges, split-horizon DNS, and resolver debugging for production domains
keywords: ["dns", "cloudflare", "api", "ttl", "let", "encrypt", "record", "management", "automation", "strategy", "challenges", "split-horizon", "resolver", "debugging", "production"]
orb_class: moon
---

# dns

DNS patterns for production domains managed through Cloudflare or direct registrar control. Covers record types, automation via API, debugging resolution chains, and DNS-01 challenges for wildcard TLS certificates.

## 1) Record Types Reference

| Type | Purpose | Example value |
|---|---|---|
| `A` | IPv4 address | `203.0.113.10` |
| `AAAA` | IPv6 address | `2001:db8::1` |
| `CNAME` | Alias to another hostname | `myapp.example.com` |
| `MX` | Mail exchange (with priority) | `10 mail.example.com` |
| `TXT` | Arbitrary text (SPF, DKIM, ownership) | `v=spf1 include:sendgrid.net ~all` |
| `NS` | Authoritative nameservers | `ns1.cloudflare.com` |
| `SRV` | Service location | `_http._tcp 10 5 80 web.example.com` |
| `CAA` | Certificate authority restriction | `0 issue "letsencrypt.org"` |
| `PTR` | Reverse DNS (IP → name) | Set at hosting provider |

## 2) TTL Strategy

```
Production records:   300s  (5min) — fast propagation for active changes
Stable records:      3600s  (1hr)  — normal operating cost
Root / NS records:  86400s  (24hr) — only change during migrations
Pre-migration TTL:    300s         — lower 24h before any DNS change
```

Lower TTL before a planned migration. Restore after stabilization.

## 3) Cloudflare API Automation

```bash
export CF_TOKEN="your-api-token"    # Zone:DNS:Edit permission
export CF_ZONE_ID="your-zone-id"    # Get from Cloudflare dashboard → zone overview

# List all records
curl -s "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CF_TOKEN" | jq '.result[] | {name, type, content, ttl}'

# Create an A record
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"type":"A","name":"api","content":"203.0.113.10","ttl":300,"proxied":false}'

# Update a record (get ID first from list)
curl -s -X PUT "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records/$RECORD_ID" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"type":"A","name":"api","content":"203.0.113.20","ttl":300,"proxied":false}'

# Delete a record
curl -s -X DELETE "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records/$RECORD_ID" \
  -H "Authorization: Bearer $CF_TOKEN"
```

## 4) DNS-01 Challenge (Wildcard Certificates)

Wildcard certs (`*.example.com`) require DNS-01 challenge — certbot cannot serve a file for them.

```bash
# Certbot with Cloudflare DNS plugin
pip install certbot-dns-cloudflare

# /etc/letsencrypt/cloudflare.ini
dns_cloudflare_api_token = your-api-token

chmod 600 /etc/letsencrypt/cloudflare.ini

certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d "*.example.com" \
  -d "example.com"
```

Certbot will add a `_acme-challenge.example.com` TXT record, wait for propagation, verify, then remove it.

## 5) Resolution Debugging

```bash
# Basic lookup
dig example.com
dig example.com A                  # explicit type
dig example.com MX
dig +short example.com             # value only

# Query a specific resolver
dig @1.1.1.1 example.com           # Cloudflare
dig @8.8.8.8 example.com           # Google
dig @208.67.222.222 example.com    # OpenDNS

# Full delegation chain (authoritative trace)
dig +trace example.com

# Check propagation across resolvers
for ns in 1.1.1.1 8.8.8.8 9.9.9.9; do
  echo -n "$ns: "; dig +short @$ns example.com A
done

# Reverse DNS
dig -x 203.0.113.10
host 203.0.113.10

# Check nameservers
dig NS example.com +short
whois example.com | grep -i "name server"

# Check SOA (serial number — shows if zone updated)
dig SOA example.com
```

## 6) Split-Horizon DNS (Internal vs External)

Serve different answers to internal and external clients.

```bash
# With dnsmasq (simple local override)
# /etc/dnsmasq.d/internal.conf
address=/api.example.com/10.0.0.5        # internal: direct to private IP
server=1.1.1.1                           # upstream for everything else
```

```nginx
# nginx split_clients or geo block as alternative
geo $internal {
  default        0;
  10.0.0.0/8    1;
  192.168.0.0/16 1;
}
```

## 7) Email DNS Records

```bash
# SPF — authorize sending servers
TXT @ "v=spf1 include:sendgrid.net include:amazonses.com ~all"

# DKIM — per-provider selector (get from provider dashboard)
TXT s1._domainkey "v=DKIM1; k=rsa; p=MIGfMA0..."

# DMARC — policy and reporting
TXT _dmarc "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com; pct=100"

# Verify
dig TXT _dmarc.example.com +short
dig TXT s1._domainkey.example.com +short
```

## 8) Common Issues

| Symptom | Likely cause | Fix |
|---|---|---|
| NXDOMAIN on new record | Propagation lag | Wait; check with `dig @auth-ns` directly |
| Stale answer after update | Old TTL cached | Check `dig +norecurse @resolver` — if fresh there, client cache issue |
| Wildcard cert fails | DNS-01 TXT not visible | Verify TXT propagated: `dig _acme-challenge.example.com TXT` |
| DKIM failing | Underscore in selector not escaped | Confirm selector name matches exactly |
| Email to spam | SPF/DMARC mismatch | `dig TXT example.com` — ensure SPF includes all senders |
| PTR mismatch | rDNS not set at provider | Set at VPS host control panel, not Cloudflare |

## 9) Checklist

- [ ] TTL lowered to 300s at least 24h before any planned migration
- [ ] `CAA` record restricts cert issuance to known CAs
- [ ] SPF, DKIM, DMARC all set and passing mail-tester.com check
- [ ] PTR (rDNS) configured at VPS host for mail server IP
- [ ] Cloudflare API token scoped to DNS:Edit only (not global API key)
- [ ] Wildcard cert uses DNS-01 challenge, not HTTP-01
- [ ] `dig +trace` baseline captured for new domains
