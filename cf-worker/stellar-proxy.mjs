// stellar.ask-meridian.uk proxy worker
//
// Forwards stellar.ask-meridian.uk/* → ask-meridian.uk/stellar/*
// (rewriting only the path; preserves Range, conditional, etag headers).
//
// Why a worker rather than a Pages custom domain: ask-meridian.uk is
// already the GH Pages CNAME for the apex repo, and GH Pages only
// supports one custom domain per repo. Hosting the dashboard inside
// the existing landing/ tree at /stellar/ means we get versioning,
// CI, and cache invalidation for free; the worker just maps the
// requested subdomain to that path.
//
// Deploy:
//   cd cf-worker && wrangler deploy --config wrangler.stellar.toml
//
// DNS prerequisite (one-time, in Cloudflare):
//   Type=CNAME  Name=stellar  Target=stellar-proxy.<your-account>.workers.dev
//   (proxy on)  TTL=auto
// Worker route:
//   Pattern=stellar.ask-meridian.uk/*  Worker=stellar-proxy

const ORIGIN = "https://ask-meridian.uk";
const PREFIX = "/stellar";

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname === "/" ? "/" : url.pathname;
    const target = `${ORIGIN}${PREFIX}${path === "/" ? "/" : path}${url.search}`;

    const upstream = await fetch(target, {
      method: req.method,
      headers: req.headers,
      redirect: "manual",
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
    });

    // Pass through with same status/headers — the worker is intentionally thin.
    const headers = new Headers(upstream.headers);
    headers.set("x-stellar-proxy", "ask-meridian.uk/stellar");
    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  },
};
