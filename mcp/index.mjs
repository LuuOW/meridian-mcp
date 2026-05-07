#!/usr/bin/env node
// Meridian MCP — stdio server, fully self-contained.
//
// On every route_task call:
//   1. Llama-3.3-70B (via GitHub Models) generates 5 candidate entries
//      for the task — slug, description, keywords, body. A candidate
//      can be any routable entity (tool, prompt, document, product…).
//   2. The bundled orbital classifier ranks the candidates and assigns
//      each a celestial body class (planet / moon / trojan / asteroid /
//      comet / irregular), parent, star system, and lagrange potential.
//   3. The ranked list is returned as agent-readable markdown with each
//      candidate's full body inline so the caller LLM can lift it straight
//      into its context window.
//
// No backend, no Cloudflare Worker, no curated corpus, no Python. The
// only network call is to GitHub Models. Set MERIDIAN_GITHUB_TOKEN (or
// GITHUB_TOKEN) — a fine-grained PAT with `Models: read` is enough.
//
// For a remote/HTTP variant (Grok connector, ChatGPT custom MCP, etc.)
// see mcp/http.mjs.

import { Server }              from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { PKG_VERSION, TOOLS, routeTask } from './_lib/core.mjs'

const TOKEN = process.env.MERIDIAN_GITHUB_TOKEN || process.env.GITHUB_TOKEN || ''

const server = new Server(
  { name: 'meridian', version: PKG_VERSION },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params
  if (name !== 'route_task') {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  }
  try {
    const text = await routeTask({ task: args.task, limit: args.limit, token: TOKEN })
    return { content: [{ type: 'text', text }] }
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message || e}` }], isError: true }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
