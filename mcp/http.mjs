#!/usr/bin/env node
// Meridian Skills MCP — HTTP (Streamable HTTP) variant.
//
// Same tool surface and orbital classifier as the stdio entrypoint
// (mcp/index.mjs), but exposed over HTTP so it can be used as a
// remote MCP connector (Grok connectors, ChatGPT custom MCPs, any
// host that asks for an MCP "server URL").
//
// Auth: bearer token in the Authorization header IS the user's
// GitHub PAT — it's passed straight through to GitHub Models. The
// server itself stores no credentials and accrues no inference cost
// for its operator. Each Grok user configures the connector with
// their own `Models: read` PAT.
//
// Stateless: a fresh Server + StreamableHTTPServerTransport is built
// per request so the bearer token can be captured in the call
// handler's closure without any session/AsyncLocalStorage plumbing.
//
// Endpoints:
//   POST /mcp       — JSON-RPC over Streamable HTTP (the connector URL)
//   GET  /healthz   — liveness ('ok')
//   GET  /          — short HTML landing pointer

import { createServer } from 'node:http'

import { Server }                          from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport }   from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { PKG_VERSION, TOOLS, routeTask } from './_lib/core.mjs'

const PORT  = parseInt(process.env.PORT || '3333', 10)
const HOST  = process.env.HOST || '0.0.0.0'
const PATH_ = process.env.MERIDIAN_HTTP_PATH || '/mcp'

// Some hosts (or operators wanting a single shared key) prefer a fixed
// gateway token. If MERIDIAN_GATEWAY_TOKEN is set, the bearer is matched
// against it AND MERIDIAN_GITHUB_TOKEN must be set in env (the server
// uses its own GitHub PAT). When unset, the bearer = the user's GitHub
// PAT (default mode).
const GATEWAY_TOKEN = process.env.MERIDIAN_GATEWAY_TOKEN || ''
const SERVER_GH_TOKEN = process.env.MERIDIAN_GITHUB_TOKEN || process.env.GITHUB_TOKEN || ''

function extractBearer(req) {
  const h = req.headers['authorization'] || req.headers['Authorization']
  if (!h) return null
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim())
  return m ? m[1].trim() : null
}

function resolveGitHubToken(bearer) {
  if (GATEWAY_TOKEN) {
    if (bearer !== GATEWAY_TOKEN) return { error: 'invalid bearer token' }
    if (!SERVER_GH_TOKEN)         return { error: 'server misconfigured: MERIDIAN_GITHUB_TOKEN unset' }
    return { token: SERVER_GH_TOKEN }
  }
  if (!bearer) return { error: 'missing Authorization: Bearer <github-pat>' }
  return { token: bearer }
}

function buildServer(githubToken) {
  const server = new Server(
    { name: 'meridian-skills', version: PKG_VERSION },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    if (name !== 'route_task') {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
    }
    try {
      const text = await routeTask({ task: args.task, limit: args.limit, token: githubToken })
      return { content: [{ type: 'text', text }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message || e}` }], isError: true }
    }
  })

  return server
}

// ─── Body reader ──────────────────────────────────────────────────
// The transport accepts a pre-parsed body to skip its own buffering.
async function readJsonBody(req, max = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (c) => {
      total += c.length
      if (total > max) { req.destroy(); reject(new Error('payload too large')); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined)
      try {
        const txt = Buffer.concat(chunks).toString('utf8')
        resolve(txt ? JSON.parse(txt) : undefined)
      } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers })
  res.end(body)
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

  // CORS — Grok / browser-based MCP hosts do preflight checks.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin':  req.headers.origin || '*',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id',
      'access-control-expose-headers': 'mcp-session-id',
      'access-control-max-age': '86400',
    })
    res.end()
    return
  }

  if (url.pathname === '/healthz') return send(res, 200, 'ok')

  if (url.pathname === '/' && req.method === 'GET') {
    return send(res, 200,
      `Meridian Skills MCP v${PKG_VERSION} — POST ${PATH_} with bearer token. https://ask-meridian.uk\n`)
  }

  if (url.pathname !== PATH_) return send(res, 404, 'not found')

  const bearer = extractBearer(req)
  const resolved = resolveGitHubToken(bearer)
  if (resolved.error) {
    return sendJson(res, 401, {
      jsonrpc: '2.0', id: null,
      error: { code: -32001, message: resolved.error },
    })
  }

  // Permissive CORS on the actual response too.
  const corsHeaders = {
    'access-control-allow-origin': req.headers.origin || '*',
    'access-control-expose-headers': 'mcp-session-id',
  }
  for (const [k, v] of Object.entries(corsHeaders)) res.setHeader(k, v)

  // Stateless: fresh Server + transport per request, capturing the
  // resolved GitHub token in the handler's closure.
  let parsedBody
  try {
    if (req.method === 'POST') parsedBody = await readJsonBody(req)
  } catch (e) {
    return sendJson(res, 400, {
      jsonrpc: '2.0', id: null,
      error: { code: -32700, message: `parse error: ${e.message}` },
    })
  }

  const server    = buildServer(resolved.token)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

  res.on('close', () => {
    try { transport.close() } catch {}
    try { server.close() } catch {}
  })

  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, parsedBody)
  } catch (e) {
    if (!res.headersSent) {
      sendJson(res, 500, {
        jsonrpc: '2.0', id: null,
        error: { code: -32603, message: `internal error: ${e.message || e}` },
      })
    }
  }
})

httpServer.listen(PORT, HOST, () => {
  const auth = GATEWAY_TOKEN ? 'gateway-token (server uses its own MERIDIAN_GITHUB_TOKEN)' : 'pass-through (bearer = user GitHub PAT)'
  console.log(`[meridian-mcp-http] listening on http://${HOST}:${PORT}${PATH_}  ·  auth=${auth}  ·  v${PKG_VERSION}`)
})
