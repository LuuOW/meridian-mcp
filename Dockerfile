# meridian-skills-mcp — stdio MCP server
#
# Build: docker build -t meridian-skills-mcp .
# Run:   docker run --rm -i -e MERIDIAN_GITHUB_TOKEN=ghp_... meridian-skills-mcp
#
# Stdio MCP servers don't expose ports. The MCP host (Claude Desktop /
# Code, Cursor, Windsurf, …) writes JSON-RPC frames to the container's
# stdin and reads responses from stdout, so it must be invoked with
# `-i` (stdin attached) but no port mapping.
#
# Glama's introspection workflow only calls `tools/list`, which doesn't
# require any environment variable — set MERIDIAN_GITHUB_TOKEN only
# when you actually want to call the route_task tool.

FROM node:20-alpine

# Install the published package globally so the binary `meridian-mcp`
# resolves on $PATH the same way it does for an `npm i -g` user.
RUN npm install -g meridian-skills-mcp@2.0.0

ENTRYPOINT ["meridian-mcp"]
