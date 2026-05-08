# Meridian — LinkedIn launch post (v3.0)

Three variants. Pick whichever vibe fits. Variant **B** is the recommended first-launch — most specific hook, technical but accessible, lands the new identity (`meridian-orbital`).

> **What changed in 3.0:** the package was previously `meridian-skills-mcp`. v3 dropped the "skills" framing because it biased the LLM prompt toward AI-agent capabilities. The classifier was always domain-agnostic — candidates can be tools, prompts, documents, products, or any routable entity. New name: **`meridian-orbital`**.

---

## Variant A — short (~200 words, fastest read)

> **Most "MCP routers" are vibes.**
>
> They embed your task, embed a corpus, dot-product, return top-K. Useful, but it's a black box and the answer drifts run-to-run.
>
> I built **Meridian** with a different bet: **let an LLM author candidate routing entries on the fly, then judge them with a deterministic orbital classifier**. Each candidate gets an 11-dimensional physics signature (mass, scope, independence, cross-domain affinity, dep_ratio, fragmentation, drag, Lagrange potential, plus orbital parameters) and a celestial body class via argmax over six scoring rules: planet, moon, trojan, asteroid, comet, irregular.
>
> The class assignment has a closed form. You can read why a candidate ranked where it did — `score_planet = min(m, s, i)^1.5`, `score_trojan = d_r · 𝟙[parent] · (1−f)`, etc. No embedding distances, no learned ranker, no black box.
>
> 📦 npm: `meridian-orbital`
> 🌐 [ask-meridian.uk](https://ask-meridian.uk) (free, no card)
> 🔭 [ask-meridian.uk/miniapp](https://ask-meridian.uk/miniapp) — type a task, see the orbits
>
> #MCP #ClaudeCode #LLM #ModelContextProtocol

---

## Variant B — recommended (~280 words, technical hook + the formulas)

> **What if your routing was wrong, but legibly so?**
>
> Most retrieval-style routers (RAG, MCP corpora, "skill" indexes) are an embedding pre-filter + cosine similarity. The output drifts run-to-run, the ranking has no internal structure, and you can't tell why one candidate beat another.
>
> Last week I shipped **Meridian 3.0**. Two stages, fully observable:
>
> **1.** Llama-3.3-70B (via GitHub Models' free tier) emits N candidate routing entries — slug, description, keywords, markdown body. No fixed corpus.
>
> **2.** A deterministic classifier extracts an 11-dimensional physics signature from each candidate's content alone, then assigns one of six celestial body classes by argmax:
>
> ```
> score_planet    = min(mass, scope, independence)^1.5
> score_moon      = 2 · max(0, ½ - i) · 𝟙[parent] · (1 - m/2)
> score_trojan    = dep_ratio · 𝟙[parent] · (1 - fragmentation)
> score_asteroid  = 2.5 · max(0, 0.55 - mass) · scope · independence
> score_comet     = drag · cross_domain · (1 - dep_ratio)
> score_irregular = 0.85 · cross_domain · fragmentation
>
> class(p) = argmax_c score_c(p)
> ```
>
> No learned ranker on top. The browser endpoint adds a bounded SGD correction layer (`route_score × (1 + tanh(K · w·x))`, fitted online from real engagement clicks, multiplier ∈ [0, 2] so no candidate can be silently boosted beyond 2× heuristic). The OAuth-gated MCP path stays purely deterministic.
>
> Real-data eval: **81% recall@1 [95% Wilson CI 60%, 92%]** on a public single-tool-routing benchmark.
>
> Three months in, still on Cloudflare's free tier. 📦 `npm i -g meridian-orbital`
>
> 🌐 https://ask-meridian.uk · 📐 [docs](https://ask-meridian.uk/docs/) · 📊 [calibration write-up](https://ask-meridian.uk/blog/orbital-classifier-online-learning/)
>
> #MCP #LLMTools #ModelContextProtocol #AIAgents

---

## Variant C — long (~520 words, narrative for technical-leadership feeds)

> **Don't physics your way out of an empirical labelling problem.**
>
> Lesson from a month spent calibrating an MCP router. Worth sharing because I tried the obvious clever moves first, and watched each fail in turn.
>
> The setup: my orbital classifier — six celestial body classes (planet, moon, trojan, asteroid, comet, irregular) assigned by argmax over six per-class scoring rules over an 11-dim physics signature — had a planet bias. 17 of 18 panel skills classified as `planet`. The formulas hadn't changed. The LLM behind the candidate-generation step had drifted out from under the heuristic constants.
>
> So I tried physics. Twice.
>
> **Vallado §12.7** (Circular Restricted Three-Body Problem, Jacobi constant, Lagrange points). Every celestial class has a textbook physical definition. I built the simulator. The math worked. The classification result was 22% — *worse* than the bug I started with.
>
> **Sears & Zemansky vol 2** (spectral classification, Stefan-Boltzmann + Doppler-broadened emission lines). 33%, also worse.
>
> Both frameworks were mathematically correct. The bottleneck wasn't the physics — it was the SKILL.md → physics-vector encoding, which has no closed-form solution.
>
> **What actually worked:** a boring heuristic retune (renormalise mass for current LLM body lengths; switch planet score from product to `min(m, s, i)^1.5`; raise the asteroid threshold from 0.4 → 0.55). Hit **50% on the synthetic panel** and **81% recall@1 [95% Wilson CI 60%, 92%]** on real labelled tool-routing data from the `shawhin/tool-use-finetuning` Hugging Face dataset.
>
> Then I closed the loop with online SGD: every browser click runs one pairwise-ranking step (logistic loss, lr 0.02, L2 0.001, KV-backed weights) so the heuristic gets a fitted correction without any local training. Constant per-request cost. No GPU. The OAuth-gated `/mcp` path stays purely deterministic for connector reproducibility.
>
> Two more textbook physics framings tried (Bell & Glasstone Breit-Wigner resonance, branching-ratio softmax) — both diagnostic-only. Five textbook frameworks attempted, one calibration retune wins. The pattern is unambiguous.
>
> Then I caught a calibration bug in *my own confidence intervals*: the bootstrap I shipped first (10,000 resamples, Bell & Glasstone Monte Carlo §1.6e) under-covered at high p — at the true rate p=0.95, nominal 95% bootstrap CIs only contained the truth 66% of the time. Swapped to Wilson score interval (closed-form, 18 lines, 1927). Same answer at 0 compute, correctly calibrated.
>
> Today: rebranded to `meridian-orbital` and dropped the "skills" framing — candidates can be any routable entity, not just AI-agent capabilities.
>
> The receipt: five simulation scripts in the repo, every claim has a script that reproduces it, every blog post links to the data.
>
> Free tier, no card. `npm i -g meridian-orbital` or paste `https://mcp.ask-meridian.uk/mcp` into Grok / ChatGPT / Claude.ai connector setup.
>
> https://ask-meridian.uk
>
> #LLMTools #ModelContextProtocol #BuildInPublic #ClassicalAI

---

# Screenshot shot list (v3.0 — capture from the live site)

| # | URL | What to capture | Crop hint |
|---|---|---|---|
| **1 — hero + math** | `https://ask-meridian.uk` | The hero: title "Dynamic task routing via orbital mechanics", the new lead paragraph, **the KaTeX math-block showing the six class-scoring rules + argmax**. The legend below the formulas should be visible. | Full-width browser, ~1600×1100. Crop from nav down through the math block. The block's gradient violet→cyan border should pop. |
| **2 — miniapp results with side panel open** | `https://ask-meridian.uk/miniapp` | Run a query like *"calibrate a binomial proportion confidence interval"*, wait for results, **click the top result** to open the side panel showing classification (physics bars, decision rule, markdown body) | Frame the result list on the left + side panel on the right. The mini-galaxy at the top should be visible. |
| **3 — mini-galaxy in 3D** | `https://ask-meridian.uk/miniapp` | After running a query, switch the mini-galaxy toggle to **3D**, drag to a tilted angle showing the orbits as ellipses with bodies at varying depths | Just the mini-galaxy frame, ~1200×600. |
| **4 — blog post with charts** | `https://ask-meridian.uk/blog/orbital-classifier-online-learning/` | The recall@1/recall@5 chart showing v2 0.81 [0.60, 0.92] vs trivial vs random, **with the Wilson CI annotations visible** | Full viewport. The chart caption mentioning the bootstrap → Wilson swap is the credibility hook. |

**Optional 5th** for terminal social proof:
| 5 | terminal | `npm install -g meridian-orbital && claude mcp add meridian meridian-mcp` install + a `route_task` call returning the JSON | Dark-theme terminal, prompt visible, output showing class field per candidate. |

---

# Posting workflow

1. Take the 4 screenshots — the hero math block (#1) is the cover image; LinkedIn shows it large.
2. Pick a variant (B is the recommended hook for v3 because it puts the formulas front-and-centre).
3. Post on LinkedIn → upload screenshots in order.
4. Cross-post:
   - **X / Twitter**: variant A's first paragraph + link.
   - **Hacker News**: "Show HN: Meridian 3.0 — open-domain orbital classifier with closed-form class assignment".
   - **r/MachineLearning**: variant C, prefixed `[P]`. The "tried five physics frameworks, one retune won" framing is the hook.
   - **Discord** (#showcase in any MCP-relevant server).
5. Best time: Tue / Wed / Thu, 8–10am or 12–1pm in your target audience's timezone.

---

# Migration call-out (for any v2.x readers in your network)

> If you previously installed `meridian-skills-mcp`, the package was renamed in 3.0:
>
> ```bash
> npm uninstall -g meridian-skills-mcp
> npm install -g meridian-orbital
> ```
>
> Binaries (`meridian-mcp`, `meridian-mcp-http`) are unchanged, so any existing `claude mcp add meridian meridian-mcp` config keeps working. The hosted HTTP MCP at `https://mcp.ask-meridian.uk/mcp` is unchanged — Grok / ChatGPT / Claude.ai connectors don't need any reconfiguration.
