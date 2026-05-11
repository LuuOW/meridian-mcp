// helio.ask-meridian.uk proxy worker
//
// Forwards helio.ask-meridian.uk/* → ask-meridian.uk apex:
//   "/"          → ask-meridian.uk/helio/   (the HelioCast dashboard)
//   anything else → ask-meridian.uk/<path>  (shared assets / blog / etc)
//
// This is the "pass-through with one rewrite" pattern arrived at after the
// stellar-proxy bug where naive prefixing broke /img/, /style.css, /nav.js.
//
// Deploy:
//   cd cf-worker && wrangler deploy --config wrangler.helio.toml
//
// DNS prerequisite (one-time, in Cloudflare):
//   Type=CNAME  Name=helio  Target=helio-proxy.<your-account>.workers.dev
//   (proxy on)  TTL=auto
// Worker route:
//   Pattern=helio.ask-meridian.uk/*  Worker=helio-proxy

const ORIGIN = "https://ask-meridian.uk";
const PREFIX = "/helio";

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname === "/" ? `${PREFIX}/` : url.pathname;
    const target = `${ORIGIN}${path}${url.search}`;

    const upstream = await fetch(target, {
      method: req.method,
      headers: req.headers,
      redirect: "manual",
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
    });

    const headers = new Headers(upstream.headers);
    headers.set("x-helio-proxy", "ask-meridian.uk/helio (root) or apex pass-through");
    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  },
};
