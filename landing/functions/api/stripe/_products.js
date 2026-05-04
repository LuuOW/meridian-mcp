// One-time digital products sold direct from ask-meridian.uk via Stripe.
// Mirror of the Gumroad listings — same files, lower fee, owned brand.
//
// Each product maps a slug → Stripe price-id env var → download URL.
// Adding a new product: append here + bind a new STRIPE_PRICE_<SLUG>
// env var on the Pages project.

export const PRODUCTS = {
  'build-your-own-mcp': {
    slug:           'build-your-own-mcp',
    name:           'Build Your Own MCP Server With Auth + Billing — In 30 Minutes',
    price_env_var:  'STRIPE_PRICE_BYOMCP',
    download_url:   'https://ask-meridian.uk/downloads/zDpgeFgXnp5p2N_1JsOFniG7e5MB3VvD.zip',
    filename:       'Build-Your-Own-MCP-Server-v1.0.zip',
    description:    '60-page guide + working Cloudflare Worker template + npm-publishable stdio shim.',
    price_display:  '$29',
  },
  'mcp-server-pack': {
    slug:           'mcp-server-pack',
    name:           'MCP Server Pack — 10 Production-Ready MCP Servers for Claude Code',
    price_env_var:  'STRIPE_PRICE_MCP_SERVER_PACK',
    download_url:   'https://ask-meridian.uk/downloads/gadVns9GJ-qIEahkIJQGkcqxwbXGnH-L.zip',
    filename:       'mcp-server-pack-v1.0.zip',
    description:    '10 single-purpose MCP servers (calc, time, fs-search, hn, arxiv, regex, json-tools, markdown, wikipedia, dns) + install script.',
    price_display:  '$49',
  },
}

export function getProduct(slug) {
  return PRODUCTS[slug] || null
}
