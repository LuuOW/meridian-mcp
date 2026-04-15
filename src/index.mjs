#!/usr/bin/env node
// Meridian Skills MCP — stdio transport (for `claude mcp add`)
import { Server }              from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  routeTask, getSkill, searchSkills, listSkillsFromDisk,
} from './skills.mjs'

const server = new Server(
  { name: 'meridian-skills', version: '0.1.0' },
  { capabilities: { tools: {}, resources: {} } },
)

const TOOLS = [
  {
    name: 'route_task',
    description:
      'Route a task description to the most relevant skills via orbital routing. Returns ranked list of skill slugs with route_score and reasoning.',
    inputSchema: {
      type: 'object',
      properties: {
        task:  { type: 'string', description: 'The task / question / context' },
        limit: { type: 'integer', description: 'Max skills to return (1-20, default 5)', default: 5 },
      },
      required: ['task'],
    },
  },
  {
    name: 'get_skill',
    description: 'Fetch the full SKILL.md content for a specific skill slug.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Skill directory name (e.g. "physics-units-si")' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'list_skills',
    description: 'List all available skill slugs.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search_skills',
    description: 'Full-text search across all skill names, descriptions, and bodies. Returns hits with snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for (case-insensitive)' },
      },
      required: ['query'],
    },
  },
]

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params
  try {
    let result
    switch (name) {
      case 'route_task':
        result = await routeTask(args.task, args.limit ?? 5)
        break
      case 'get_skill':
        result = getSkill(args.slug)
        break
      case 'list_skills':
        result = { skills: listSkillsFromDisk() }
        break
      case 'search_skills':
        result = { query: args.query, hits: searchSkills(args.query) }
        break
      default:
        throw new Error(`Unknown tool: ${name}`)
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (e) {
    return {
      content: [{ type: 'text', text: `Error: ${e.message}` }],
      isError: true,
    }
  }
})

// Expose skills as resources too, so agents can enumerate them as a corpus
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: listSkillsFromDisk().map(slug => ({
    uri: `meridian://skills/${slug}`,
    name: slug,
    description: `Skill: ${slug}`,
    mimeType: 'text/markdown',
  })),
}))

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const match = req.params.uri.match(/^meridian:\/\/skills\/([a-z0-9_-]+)$/i)
  if (!match) throw new Error(`Invalid resource URI: ${req.params.uri}`)
  const { body, frontmatter } = getSkill(match[1])
  const text = `---\nname: ${frontmatter.name || match[1]}\ndescription: ${frontmatter.description || ''}\n---\n\n${body}`
  return { contents: [{ uri: req.params.uri, mimeType: 'text/markdown', text }] }
})

const transport = new StdioServerTransport()
await server.connect(transport)
