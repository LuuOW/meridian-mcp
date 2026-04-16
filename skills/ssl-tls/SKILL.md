---
name: ssl-tls
description: TLS certificate lifecycle — Let's Encrypt HTTP-01 and DNS-01 issuance, renewal automation, mTLS, HSTS, OCSP stapling, certificate inspection, and Nginx TLS hardening
---

# ssl-tls

TLS certificate management for production services. Covers Let's Encrypt issuance strategies, Nginx TLS hardening, mutual TLS for internal service auth, and certificate inspection/debugging.

## 1) Let's Encrypt — HTTP-01 (Single Domain)

```bash
apt install certbot python3-certbot-nginx

# Issue cert and auto-configure Nginx
certbot --nginx -d example.com -d www.example.com

# Issue cert only (configure Nginx manually)
certbot certonly --nginx -d example.com

# Standalone mode (if Nginx not installed)
certbot certonly --standalone -d example.com

# Verify auto-renewal timer
systemctl status certbot.timer
certbot renew --dry-run
```

## 2) Let's Encrypt — DNS-01 (Wildcard)

```bash
pip install certbot-dns-cloudflare

cat > /etc/letsencrypt/cloudflare.ini << 'EOF'
dns_cloudflare_api_token = YOUR_CF_TOKEN
EOF
chmod 600 /etc/letsencrypt/cloudflare.ini

certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d "*.example.com" -d "example.com"
```

## 3) Nginx TLS Hardening

```nginx
server {
    listen 443 ssl http2;
    server_name example.com;

    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    # Modern compatibility (drops IE11 / old Android)
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256;
    ssl_prefer_server_ciphers off;

    # Session resumption
    ssl_session_timeout 1d;
    ssl_session_cache shared:MozSSL:10m;
    ssl_session_tickets off;

    # OCSP stapling
    ssl_stapling on;
    ssl_stapling_verify on;
    ssl_trusted_certificate /etc/letsencrypt/live/example.com/chain.pem;
    resolver 1.1.1.1 8.8.8.8 valid=300s;
    resolver_timeout 5s;

    # HSTS — preload-ready (6 months)
    add_header Strict-Transport-Security "max-age=15768000; includeSubDomains; preload" always;

    # Other security headers
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}

# HTTP → HTTPS redirect
server {
    listen 80;
    server_name example.com www.example.com;
    return 301 https://$host$request_uri;
}
```

## 4) Certificate Inspection

```bash
# View cert from file
openssl x509 -in /etc/letsencrypt/live/example.com/cert.pem -text -noout

# View cert from live server
echo | openssl s_client -connect example.com:443 -servername example.com 2>/dev/null \
  | openssl x509 -noout -dates -subject -issuer

# Check expiry only
echo | openssl s_client -connect example.com:443 2>/dev/null \
  | openssl x509 -noout -enddate

# Verify cert chain
openssl verify -CAfile /etc/ssl/certs/ca-certificates.crt \
  /etc/letsencrypt/live/example.com/cert.pem

# Test TLS handshake + cipher negotiated
openssl s_client -connect example.com:443 -tls1_3
openssl s_client -connect example.com:443 -cipher ECDHE-RSA-AES256-GCM-SHA384

# Check OCSP stapling
openssl s_client -connect example.com:443 -status 2>/dev/null | grep -A 10 "OCSP response"
```

## 5) mTLS — Mutual TLS for Internal Services

Both sides present a certificate. Use for internal API-to-API auth without shared secrets.

```bash
# Create CA
openssl genrsa -out ca.key 4096
openssl req -new -x509 -days 1826 -key ca.key -out ca.crt \
  -subj "/CN=Internal CA/O=MyOrg"

# Server cert signed by CA
openssl genrsa -out server.key 2048
openssl req -new -key server.key -out server.csr -subj "/CN=api.internal"
openssl x509 -req -days 365 -in server.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out server.crt

# Client cert signed by CA
openssl genrsa -out client.key 2048
openssl req -new -key client.key -out client.csr -subj "/CN=client-service"
openssl x509 -req -days 365 -in client.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out client.crt
```

```nginx
# Nginx — require client cert
server {
    listen 443 ssl;
    ssl_certificate     /etc/ssl/server.crt;
    ssl_certificate_key /etc/ssl/server.key;
    ssl_client_certificate /etc/ssl/ca.crt;
    ssl_verify_client on;     # reject requests without valid client cert
}
```

```bash
# Test with client cert
curl --cert client.crt --key client.key --cacert ca.crt https://api.internal/health
```

## 6) Certificate Rotation Script

```bash
#!/bin/bash
# /opt/scripts/cert-check.sh — alert 14 days before expiry
DOMAIN="example.com"
EXPIRY=$(echo | openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" 2>/dev/null \
  | openssl x509 -noout -enddate | cut -d= -f2)
EXPIRY_EPOCH=$(date -d "$EXPIRY" +%s)
NOW_EPOCH=$(date +%s)
DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))

if [ "$DAYS_LEFT" -lt 14 ]; then
  curl -s -X POST "$SLACK_WEBHOOK" \
    -H 'Content-type: application/json' \
    --data "{\"text\": \":warning: TLS cert for $DOMAIN expires in ${DAYS_LEFT} days\"}"
fi
```

## 7) HSTS Preload Checklist

Before submitting to hstspreload.org:
- [ ] HTTPS works on root domain AND all subdomains
- [ ] HTTP redirects to HTTPS with 301
- [ ] `max-age >= 31536000` (1 year)
- [ ] `includeSubDomains` present
- [ ] `preload` directive present
- [ ] No mixed content warnings

## 8) Checklist

- [ ] TLSv1.0 / TLSv1.1 disabled (`ssl_protocols TLSv1.2 TLSv1.3`)
- [ ] HSTS header deployed with `includeSubDomains`
- [ ] OCSP stapling enabled — reduces handshake latency
- [ ] `ssl_session_tickets off` — improves forward secrecy
- [ ] Cert expiry monitoring in place (< 14 days → alert)
- [ ] `certbot renew --dry-run` tested successfully
- [ ] Wildcard certs use DNS-01, not HTTP-01
- [ ] Internal services use mTLS where no user-facing auth exists
- [ ] `ssl_trusted_certificate` points to chain for OCSP verification
