# meridian-skills-mcp — stdio + HTTP MCP server
#
# Two modes, picked at runtime by MCP_MODE:
#
#   MCP_MODE=stdio (default) — JSON-RPC over stdin/stdout. The MCP host
#                              (Claude Desktop / Code, Cursor, Windsurf)
#                              must spawn the container with `-i`.
#
#   MCP_MODE=http             — Streamable HTTP server on $PORT (default
#                              3333). Use this for Grok connectors,
#                              ChatGPT custom MCPs, any host that asks
#                              for an MCP "server URL". Bearer token in
#                              the Authorization header is the user's
#                              GitHub PAT (passed through to GitHub
#                              Models). For a shared-key gateway, set
#                              MERIDIAN_GATEWAY_TOKEN + MERIDIAN_GITHUB_TOKEN.
#
# Build: docker build -t meridian-skills-mcp .
#
# Run (stdio):
#   docker run --rm -i -e MERIDIAN_GITHUB_TOKEN=ghp_... meridian-skills-mcp
#
# Run (HTTP):
#   docker run --rm -p 3333:3333 -e MCP_MODE=http meridian-skills-mcp
#   # then point Grok at https://your-host:3333/mcp with the user PAT
#
# Glama's introspection workflow only calls `tools/list`, which doesn't
# require any environment variable — set MERIDIAN_GITHUB_TOKEN only
# when you actually want to call the route_task tool.

FROM node:20-alpine

# Install the published package globally so the binaries
# `meridian-mcp` and `meridian-mcp-http` resolve on $PATH the same way
# they do for an `npm i -g` user.
RUN npm install -g meridian-skills-mcp@2.1.0

ENV MCP_MODE=stdio
ENV PORT=3333
EXPOSE 3333

# Tiny shim picks the right binary at runtime. exec → keeps PID 1
# semantics so signals reach the Node process.
ENTRYPOINT ["sh", "-c", "if [ \"$MCP_MODE\" = http ]; then exec meridian-mcp-http; else exec meridian-mcp; fi"]
