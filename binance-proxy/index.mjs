// binance-proxy — Worker → Fly → Bright Data → Binance.
//
// CF Worker egress is geo-blocked by Binance, and Fly's egress IPs are
// also blanket-blocked (cloud-ASN list). Bright Data's DC zone hands
// us one residential-grade IP that Binance accepts AND we can
// whitelist on the API key. This Fly machine is a tiny HTTP-CONNECT
// shim because Workers can't open arbitrary CONNECT tunnels.

import { createServer } from "node:http"
import { request as httpsRequest } from "node:https"
import { HttpsProxyAgent } from "https-proxy-agent"

const SECRET  = process.env.PROXY_SECRET
const BD_USER = process.env.BRIGHTDATA_USER
const BD_PASS = process.env.BRIGHTDATA_PASS
const BD_HOST = process.env.BRIGHTDATA_HOST || "brd.superproxy.io"
const BD_PORT = Number(process.env.BRIGHTDATA_PORT || 33335)

if (!SECRET)  { console.error("FATAL: PROXY_SECRET required");  process.exit(1) }
if (!BD_USER) { console.error("FATAL: BRIGHTDATA_USER required"); process.exit(1) }
if (!BD_PASS) { console.error("FATAL: BRIGHTDATA_PASS required"); process.exit(1) }

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080
const BD_URL = `http://${encodeURIComponent(BD_USER)}:${encodeURIComponent(BD_PASS)}@${BD_HOST}:${BD_PORT}`
const agent = new HttpsProxyAgent(BD_URL)

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("ok")
    return
  }
  if (req.url === "/debug/exit-ip") {
    httpsRequest({ host: "api.ipify.org", port: 443, path: "/", method: "GET", agent, servername: "api.ipify.org" }, r => {
      let body = ""
      r.on("data", c => body += c)
      r.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ exit_ip_via_bd: body.trim(), status: r.statusCode }))
      })
    }).on("error", e => {
      res.writeHead(502); res.end(JSON.stringify({ error: e.message }))
    }).end()
    return
  }
  if (req.url === "/debug/binance-time-clean") {
    // Identical to the Mac-side script that worked: minimal headers, no passthrough
    httpsRequest({ host: "api.binance.com", path: "/api/v3/time", method: "GET", agent, servername: "api.binance.com" }, r => {
      let body = ""
      r.on("data", c => body += c)
      r.on("end", () => {
        res.writeHead(r.statusCode || 502, { "content-type": "application/json" })
        res.end(JSON.stringify({ status: r.statusCode, body: body.slice(0, 300) }))
      })
    }).on("error", e => {
      res.writeHead(502); res.end(JSON.stringify({ error: e.message }))
    }).end()
    return
  }
  if (req.headers["x-proxy-secret"] !== SECRET) {
    res.writeHead(403, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "forbidden" }))
    return
  }

  const upstreamHost = req.url?.startsWith("/fapi/")
    ? "fapi.binance.com"
    : "api.binance.com"

  const headers = filterHeaders(req.headers)
  headers.host = upstreamHost

  const upstream = httpsRequest(
    {
      host: upstreamHost,
      port: 443,
      method: req.method,
      path: req.url,
      headers,
      agent,
      servername: upstreamHost,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    },
  )
  upstream.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" })
    }
    res.end(JSON.stringify({ error: "upstream", detail: err.message }))
  })
  req.pipe(upstream)
})

// Allowlist what Binance actually needs. Anything else (Fly-*, X-Forwarded-*,
// CDN headers, Cloudflare metadata) leaks our edge to Binance's WAF and trips
// CloudFront 403.
const ALLOWED = new Set([
  "x-mbx-apikey",
  "content-type",
  "content-length",
  "user-agent",
])

function filterHeaders(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    if (ALLOWED.has(k.toLowerCase())) out[k] = v
  }
  return out
}

server.listen(PORT, () => {
  console.log(`binance-proxy → BD(${BD_HOST}:${BD_PORT}) listening on :${PORT}`)
})
