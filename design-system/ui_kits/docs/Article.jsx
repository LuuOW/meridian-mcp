function Article() {
  return (
    <article className="docs-article">
      <span className="eyebrow">Transports · Grok</span>
      <h1>Use as a Grok connector</h1>
      <p className="lead">
        A hosted Streamable-HTTP variant lives at <code>mcp.ask-meridian.uk/mcp</code> with full OAuth 2.1 + PKCE — slots into any host that requires a connector URL.
      </p>

      <Callout kind="info" title="No backend required">
        Inference runs against GitHub Models using the operator's PAT. End users never enter a token. Tokens last 1 hour and can be reauthorized any time.
      </Callout>

      <h2 id="route">The route_task tool</h2>
      <p>Single tool. Takes a natural-language task, returns ranked candidates with full markdown bodies and per-candidate decision rules.</p>

      <CodeBlock tabs={[
        { label: 'stdio', code: '# install\nnpm install -g meridian-orbital\n\n# expose your GitHub PAT (Models:read scope)\nexport MERIDIAN_GITHUB_TOKEN=github_pat_…\n\n# register the connector\nclaude mcp add meridian meridian-mcp' },
        { label: 'http', code: '# self-host the streamable-http variant\nnpx -y meridian-orbital meridian-mcp-http\n# → listening on http://0.0.0.0:3333/mcp · auth=pass-through' },
        { label: 'docker', code: 'docker run --rm -p 3333:3333 \\\n  -e MCP_MODE=http \\\n  -e MERIDIAN_GITHUB_TOKEN=$GH_TOKEN \\\n  meridian-orbital' },
      ]}/>

      <h2 id="grok">Configure inside Grok</h2>
      <p>In Grok's "Add custom connector" dialog, paste these values:</p>

      <div className="docs-table">
        <table>
          <thead><tr><th>Field</th><th>Value</th></tr></thead>
          <tbody>
            <tr><td>Server URL</td><td><code>https://mcp.ask-meridian.uk/mcp</code></td></tr>
            <tr><td>Authorization endpoint</td><td><code>https://mcp.ask-meridian.uk/authorize</code></td></tr>
            <tr><td>Token endpoint</td><td><code>https://mcp.ask-meridian.uk/token</code></td></tr>
            <tr><td>Client ID</td><td><code>grok</code></td></tr>
            <tr><td>Client secret</td><td><em>(empty)</em></td></tr>
            <tr><td>Token auth method</td><td><code>none</code> (PKCE only)</td></tr>
            <tr><td>Scopes</td><td><code>route_task</code></td></tr>
          </tbody>
        </table>
      </div>

      <Callout kind="warn" title="Same URL works for ChatGPT + Claude.ai">
        ChatGPT custom MCPs and Claude.ai connectors speak the same MCP Streamable HTTP + OAuth 2.1 spec. The endpoint is identical.
      </Callout>

      <h2 id="classes">Celestial classes</h2>
      <p>Each ranked candidate carries one of six class labels:</p>
      <ul className="class-list">
        <li><span className="class-pill" data-class="planet">Planet</span> — stable, owns its scope. <code>min(mass, scope, indep)^1.5</code></li>
        <li><span className="class-pill" data-class="moon">Moon</span> — low independence, parent-bound</li>
        <li><span className="class-pill" data-class="trojan">Trojan</span> — sibling-clustered, stable at L4/L5</li>
        <li><span className="class-pill" data-class="asteroid">Asteroid</span> — small, sharp, broad</li>
        <li><span className="class-pill" data-class="comet">Comet</span> — cross-domain, eccentric, drag-heavy</li>
        <li><span className="class-pill" data-class="irregular">Irregular</span> — weird, fragmented, novel</li>
      </ul>

      <Callout kind="success" title="Need an example?">
        Try the <a href="#">live miniapp</a> — type a task and see the same classifier in action with a visual orbit.
      </Callout>
    </article>
  );
}

window.DocsArticle = Article;
