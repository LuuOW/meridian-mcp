# Meridian — LinkedIn launch post

Three variants. Pick whichever vibe fits. Variant **B** is my recommendation for first-launch — most specific hook, technical but accessible.

---

## Variant A — short (200 words, fastest read)

> **Most "skill routers" are vibes.**
>
> They embed your task, embed a corpus, dot-product, return top-K. Useful, but it's a black box and the answer drifts run-to-run.
>
> I built **Meridian** with a different bet: **let an LLM author skills on the fly, then judge them with an open-domain orbital classifier** — every candidate gets a physics signature (mass, scope, cross-domain affinity, Lagrange potential) and a celestial class (planet, moon, trojan, asteroid, comet, irregular).
>
> Same call works as:
> - a 5 KB **MCP** for Claude Code, Cursor, Windsurf (`npm install -g meridian-skills-mcp`)
> - a **browser miniapp** with 2D/3D orbital visualisation + camera-based AR object detection
>
> Free tier, no credit card. Pro/Team plans wired through Stripe.
>
> 🌐 [ask-meridian.uk](https://ask-meridian.uk)
> 📦 npm: `meridian-skills-mcp`
> 🔭 [galaxy.ask-meridian.uk](https://galaxy.ask-meridian.uk)
>
> #MCP #ClaudeCode #LLM #AIAgents

---

## Variant B — recommended (medium, ~280 words, technical hook)

> **What if your skill router was wrong, but consistently?**
>
> Most of the "MCP skills" floating around are a curated corpus + cosine similarity over embeddings. The output drifts run-to-run, the ranking has no semantic structure, and you have no idea why one skill beat another.
>
> Last week I shipped **Meridian** — a different take. Two stages:
>
> **1.** Llama-3.3-70B writes a fresh skill set for your task. Real `## Use It For / Workflow / Heuristics / Anti-Patterns` markdown bodies. No fixed corpus.
>
> **2.** An open-domain orbital engine derives a physics signature for each one — mass, scope, independence, cross-domain affinity, Lagrange potential — and assigns a celestial class via argmax over six per-class scores: **planet, moon, trojan, asteroid, comet, irregular**. Routing score = lexical relevance × class boost × Lagrange versatility. Deterministic given the inputs.
>
> One backend, three surfaces:
> - **MCP**: 5 KB stdio shim, drop into Claude Code / Cursor / Windsurf
> - **Browser miniapp**: 2D/3D orbital canvas, camera-based AR object detection (point at a laptop, get skills relevant to laptops)
> - **Hosted API**: free per-IP, Pro $29/mo for 10K calls/mo, Team $149/mo for 100K
>
> Stack underneath: Cloudflare Workers AI + Pages Functions, KV cache, Stripe, GCP free-tier VM hosting a passkey-protected vault. Total monthly bill so far: **$0**.
>
> Try it (no install): https://ask-meridian.uk/miniapp
>
> Source + npm: https://github.com/LuuOW/meridian-mcp
>
> #MCP #ClaudeCode #LLMTools #AIAgents #Cloudflare

---

## Variant C — long (520 words, narrative for technical-leadership-LinkedIn)

> **I rebuilt my skill router. It's now both more correct and more honest.**
>
> Six months ago I shipped a "skill router for AI agents" that was basically a curated 88-skill corpus + a transformer embedding pre-filter + a Python orbital scorer. It looked clever. It was opinionated. It mostly worked.
>
> But every time I added a new task domain, I had to author SKILL.md files by hand. The closed corpus was the bottleneck. And the cosine-similarity layer at the top was a black box doing most of the heavy lifting — the orbital math underneath was, honestly, decoration.
>
> Last week I flipped the architecture.
>
> **The new pipeline:** Llama-3.3-70B (Workers AI) generates 5 candidate skills for the user's task — full opinionated markdown bodies, ## Use It For / Workflow / Heuristics / Anti-Patterns, named tools, real decision rules. Then an **open-domain orbital classifier** (JS port of the original Python algorithm, generalised to handle arbitrary skills) derives a physics signature for each one: mass from body length, scope from keyword breadth, cross-domain from Shannon entropy across forge/signal/mind term sets, fragmentation from kw-length stddev, drag from specialised-term ratio, dep_ratio from inter-skill Jaccard.
>
> Each skill gets a celestial class — planet, moon, trojan, asteroid, comet, irregular — assigned by argmax over six per-class scores. Each gets a parent (most-similar sibling), a star system (forge / signal / mind based on term-set affinity), a Lagrange potential (cross-system bridge strength). Routing score = (kw·10 + desc·5 + body·1) × diversity × class_boost × versatility.
>
> Same backend, two interfaces:
>
> 1. **`meridian-skills-mcp` v1.0.0** — npm, 5 KB tarball, single dep. Drop into Claude Code, Cursor, Windsurf, or any MCP client.
>
> 2. **ask-meridian.uk/miniapp** — browser demo with 2D/3D orbital visualisation (drag to rotate, pinch to zoom), camera-based AR object detection (point at a coffee mug → get skills for interacting with coffee mugs), live quota badge, model switcher between Workers AI and Groq.
>
> Underneath:
> - Cloudflare Pages + Workers AI + Workers KV + Cron Triggers
> - Stripe billing (Pro $29 / Team $149)
> - GCP e2-micro free-tier VM with a passkey-protected vault for credential storage
> - Cloudflare Tunnel for the vault domain
>
> Monthly infra bill: $0 within the free-tier limits.
>
> Built with Claude Code over ~3 days of iteration. Some of the cleanest agent-driven engineering I've done.
>
> The honest pitch: **deterministic routing isn't about being smart, it's about being legible.** When the system tells you "this is a trojan companion at L4/L5 of `api-rate-limiting` because dep_ratio is 0.64", you can argue with it. Argue back. Override. That's what makes a tool useful for actual engineering work.
>
> Free tier needs no install. Try it, break it, tell me what's wrong:
>
> https://ask-meridian.uk/miniapp
>
> #MCP #ClaudeCode #LLMTools #AIAgents #BuildInPublic #Cloudflare

---

# Screenshot shot list

Since I can't take these myself, here's exactly what to grab and where to crop. Use Cmd-Shift-4 on macOS or Snipping Tool on Windows. Aim for **4 screenshots** — LinkedIn shows the first one large, the rest in a 2×2 grid below.

| # | URL | What to capture | Crop hint |
|---|---|---|---|
| **1 — hero** | `https://ask-meridian.uk` | Top of landing: nav with burger, hero title "Dynamic AI skill routing via orbital mechanics", install snippet, and the three feature cards | Full-width browser, ~1600×1000. Show from nav to bottom of "How it works" section. The neon ring around the install snippet should be visible. |
| **2 — miniapp results with side panel open** | `https://ask-meridian.uk/miniapp` | Run a query like *"set up rate limiting on a public API"*, wait for results, **click the top result** to open the side panel showing the full classification (physics bars, decision rule, markdown body) | Frame the result list on the left + side panel on the right, full viewport. The mini-galaxy at the top of results should be visible. |
| **3 — mini-galaxy in 3D** | `https://ask-meridian.uk/miniapp` | After running a query, switch the mini-galaxy toggle to **3D**, drag to a tilted angle showing the orbits as ellipses with planets at varying depths. The galaxy hint pill ("drag to rotate · pinch to zoom") should still be faintly visible | Just the mini-galaxy frame, ~1200×600. Maybe annotate with an arrow pointing to the planet labels |
| **4 — full galaxy (the standalone viz)** | `https://galaxy.ask-meridian.uk` | The full orbital map with skills as planets/moons in their star systems. Pick a moment when several star-systems are visible | Full viewport. This one is visually striking and reinforces "physics-inspired" |

**Optional 5th** if you want a "social proof" shot:
| 5 | terminal | A real `claude mcp add meridian meridian-mcp` install + tool call working | Terminal with dark theme, prompt visible, output showing the routed skills |

---

# Posting workflow

1. Take the 4 screenshots
2. Pick a variant (B recommended)
3. Post on LinkedIn → upload screenshots in order (first one is the cover)
4. Tag relevant ecosystems: @Anthropic @Cloudflare (use LinkedIn's @ for company pages)
5. Cross-post to **X / Twitter** with a 280-char condensed version (variant A first paragraph + link)
6. Drop a comment on **Hacker News** if it's a slow news day → "Show HN: Meridian — LLM-generated skills with deterministic orbital classification"
7. Tweet the launch from any Anthropic/MCP-relevant Discord (#showcase channels)

**Best time to post**: Tue / Wed / Thu, 8–10 am or 12–1 pm in your target audience's timezone. Avoid Mondays (everyone's catching up) and Fridays (everyone's checked out).
