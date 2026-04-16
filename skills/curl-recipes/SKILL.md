---
name: curl-recipes
description: curl one-liners for HTTP debugging, API testing, auth header patterns, file upload, response inspection, timing breakdown, and connection tracing
---

# curl-recipes

Targeted curl patterns for debugging HTTP services, testing API endpoints, inspecting TLS, and measuring request timing. Micro-skill — composable with network, ssl-tls, api, and webhook debugging workflows.

## 1) Response Inspection

```bash
# Headers only
curl -I https://example.com

# Verbose — full request + response headers
curl -v https://example.com

# Silent body, show HTTP status code only
curl -s -o /dev/null -w "%{http_code}" https://example.com/health

# Follow redirects + show final URL
curl -L -s -o /dev/null -w "%{url_effective}\n" https://example.com

# Show response headers + body
curl -D - https://example.com
```

## 2) Auth Patterns

```bash
# Bearer token
curl -H "Authorization: Bearer $TOKEN" https://api.example.com/me

# Basic auth
curl -u username:password https://api.example.com/endpoint
curl -H "Authorization: Basic $(echo -n user:pass | base64)" https://api.example.com

# API key in header
curl -H "X-Api-Key: $API_KEY" https://api.example.com/data

# Cookie
curl -b "session=abc123" https://app.example.com/dashboard

# Client certificate (mTLS)
curl --cert client.crt --key client.key --cacert ca.crt https://internal.api/
```

## 3) POST / JSON Bodies

```bash
# JSON POST
curl -s -X POST https://api.example.com/items \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name": "test", "value": 42}'

# From file
curl -X POST https://api.example.com/ingest \
  -H "Content-Type: application/json" \
  -d @payload.json

# Form data
curl -X POST https://api.example.com/login \
  -F "username=admin" \
  -F "password=secret"

# URL-encoded form
curl -X POST https://api.example.com/token \
  -d "grant_type=client_credentials&client_id=xxx&client_secret=yyy"
```

## 4) File Upload

```bash
# Multipart file upload
curl -X POST https://api.example.com/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/file.pdf" \
  -F "name=my-document"

# PUT binary
curl -X PUT https://storage.example.com/object-key \
  -H "Content-Type: application/octet-stream" \
  --data-binary @/path/to/file.bin

# S3 presigned URL upload
curl -X PUT "$PRESIGNED_URL" \
  -H "Content-Type: image/jpeg" \
  --upload-file photo.jpg
```

## 5) Timing Breakdown

```bash
# Full timing breakdown
curl -s -o /dev/null -w "
DNS:          %{time_namelookup}s
TCP connect:  %{time_connect}s
TLS handshake:%{time_appconnect}s
TTFB:         %{time_starttransfer}s
Total:        %{time_total}s
Size:         %{size_download} bytes
Speed:        %{speed_download} B/s
" https://example.com
```

## 6) TLS & Certificate Debugging

```bash
# Show cert chain
curl -v --max-time 5 https://example.com 2>&1 | grep -E "subject|issuer|expire|SSL"

# Force TLS version
curl --tls-max 1.2 https://example.com
curl --tls13-ciphers TLS_AES_256_GCM_SHA384 https://example.com

# Skip cert verification (dev/test only)
curl -k https://localhost:8443/health

# Test with specific CA bundle
curl --cacert /etc/ssl/my-ca.crt https://internal.service/
```

## 7) Useful Flags Reference

| Flag | Effect |
|---|---|
| `-s` | Silent (no progress bar) |
| `-v` | Verbose (headers + trace) |
| `-I` | HEAD request only |
| `-L` | Follow redirects |
| `-k` | Skip TLS verification |
| `-o /dev/null` | Discard body |
| `-w "..."` | Write-out format string |
| `-D -` | Dump response headers to stdout |
| `--max-time 5` | Timeout after 5 seconds |
| `--retry 3` | Retry up to 3 times |
| `--compressed` | Request + decompress gzip |
| `-x http://proxy:8080` | Use HTTP proxy |
