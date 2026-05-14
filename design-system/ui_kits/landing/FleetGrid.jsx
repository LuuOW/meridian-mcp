function FleetCard({ emoji, name, tagline, links, coverBg }) {
  return (
    <article className="product-card" style={{ '--card-bg-image': coverBg }}>
      <div className="product-emoji" aria-hidden="true">{emoji}</div>
      <h3>{name}</h3>
      <p className="product-tagline" dangerouslySetInnerHTML={{ __html: tagline }} />
      <p className="product-tagline" style={{ marginTop: 12 }}>
        {links.map((l, i) => (
          <React.Fragment key={i}>
            <a href="#" style={{ color: '#7aa3ff' }}>{l}</a>
            {i < links.length - 1 ? ' · ' : ''}
          </React.Fragment>
        ))}
      </p>
    </article>
  );
}

function FleetGrid() {
  return (
    <section className="products" aria-label="MCP fleet" style={{ paddingTop: 24 }}>
      <h2 style={{ fontSize: 22, margin: '0 0 6px' }}>Live properties on this domain</h2>
      <p className="lead" style={{ margin: '0 0 20px', fontSize: 14 }}>
        MCPs, dashboards, and browser apps — different problems, same OAuth + PKCE shape across the stack.
      </p>
      <div className="fleet-grid">
        <FleetCard
          emoji="◎"
          name="mcp.ask-meridian.uk"
          tagline="<strong>Meridian</strong> — task → orbital classification. The flagship. Operator-pays GitHub Models inference + an online-learning Wilson-CI ranker."
          links={['Docs', 'Source']}
          coverBg="radial-gradient(ellipse at 30% 30%, rgba(124,58,237,0.45), rgba(34,211,238,0.15) 45%, rgba(6,8,15,0.95) 75%)"
        />
        <FleetCard
          emoji="◇"
          name="money.ask-meridian.uk"
          tagline="<strong>Finance</strong> — single-tenant balance MCP locked behind a WebAuthn passkey. Reads Binance through a Bright Data → Fly bridge."
          links={['Blog', 'Source']}
          coverBg="radial-gradient(ellipse at 70% 40%, rgba(16,185,129,0.35), rgba(56,189,248,0.10) 50%, rgba(6,8,15,0.95) 75%)"
        />
        <FleetCard
          emoji="💊"
          name="botica.ask-meridian.uk"
          tagline="<strong>Pharmacy</strong> — Argentine pharmacy cart MCP. Anonymous-cart over the public VTEX API."
          links={['Blog', 'Source']}
          coverBg="radial-gradient(ellipse at 50% 30%, rgba(244,114,182,0.30), rgba(167,139,250,0.10) 45%, rgba(6,8,15,0.95) 75%)"
        />
        <FleetCard
          emoji="☀"
          name="ask-meridian.uk/helio"
          tagline="<strong>HelioCast</strong> — solar irradiance triangulator. PSP measures the Sun directly; JWST observes bodies that reflect it."
          links={['Dashboard', 'Source']}
          coverBg="radial-gradient(ellipse at 35% 35%, rgba(251,191,36,0.45), rgba(249,115,22,0.15) 45%, rgba(6,8,15,0.95) 75%)"
        />
        <FleetCard
          emoji="🧬"
          name="meridian.ask-meridian.uk/helix"
          tagline="<strong>helix</strong> — vision/text → therapeutic protein candidates rendered as star systems. Each protein gets its own world."
          links={['Open', 'Source']}
          coverBg="radial-gradient(ellipse at 30% 30%, rgba(124,58,237,0.45), rgba(34,211,238,0.15) 45%, rgba(6,8,15,0.95) 75%)"
        />
      </div>
    </section>
  );
}

window.FleetGrid = FleetGrid;
