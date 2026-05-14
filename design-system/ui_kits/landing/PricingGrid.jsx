function Plan({ tag, name, price, period, features, ctaLabel, ctaClass = 'btn-ghost', featured = false }) {
  return (
    <div className={'plan' + (featured ? ' plan-featured' : '')}>
      {tag && <div className="plan-tag">{tag}</div>}
      <div className="plan-name">{name}</div>
      <div className="plan-price">{price}<span>/{period}</span></div>
      <ul className="plan-features">
        {features.map((f, i) => <li key={i}>{f}</li>)}
      </ul>
      <a href="#" className={'btn ' + ctaClass + ' btn-block'}>{ctaLabel}</a>
    </div>
  );
}

function PricingGrid() {
  return (
    <section className="pricing" id="pricing">
      <h2>Pricing</h2>
      <p className="lead">Try a public MCP free. Get one of the catalog MCPs deployed for you. Or have a custom MCP built around your stack.</p>
      <div className="plans">
        <Plan
          name="Public MCP"
          price="$0" period="mo"
          features={[
            'Use the public Meridian endpoint',
            '5 calls / day per IP (best-effort)',
            'No account or API key required',
            'MIT-licensed npm client',
          ]}
          ctaLabel="Connect it"
        />
        <Plan
          tag="Most popular"
          featured
          name="1 MCP"
          price="$29" period="mo"
          features={[
            'One MCP from the catalog, deployed for you',
            'Choose: Meridian / Finance / Pharmacy',
            'Your subdomain, OAuth + PKCE, KV-backed',
            'Maintenance + version bumps included',
            'Cancel anytime via Stripe portal',
          ]}
          ctaLabel="Subscribe — $29/mo"
          ctaClass="btn-primary"
        />
        <Plan
          name="Custom Enterprise MCP"
          price="$149" period="mo"
          features={[
            'Bespoke MCP built around your stack',
            'Your tools, your auth, your data sources',
            'Architecture review + 1-month build-in support',
            'Hosted on your infra or ours',
            'Direct email support',
          ]}
          ctaLabel="Subscribe — $149/mo"
        />
      </div>
      <p className="pricing-note">
        Billing via Stripe — no card data on our infrastructure.
        Need something specific that doesn't fit? <a href="#">Email me</a> directly.
      </p>
    </section>
  );
}

window.PricingGrid = PricingGrid;
