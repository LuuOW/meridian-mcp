---
name: internal-docs-operator
description: Use when working against the internal documentation surfaces on :4401 and :4400, especially for target-specific doc updates, source-of-truth checks, verification of live state, and preventing false completion claims
keywords: ["internal", "docs", "operator", "use", "working", "against", "documentation", "surfaces", "especially", "target-specific", "doc", "updates", "source-of-truth", "checks", "verification", "live", "state", "preventing"]
orb_class: irregular_satellite
---

# internal-docs-operator

Workflow for operating on the internal docs system without drifting to the wrong target or claiming unverified success.

## 1) Source Hierarchy

Treat the two internal surfaces differently:

- `http://45.9.190.170:4400` or local `http://127.0.0.1:4400`
  Higher-authority live operational source for system state, services, PM2, Docker, ports, uptime, and environment facts.
- `http://45.9.190.170:4401`
  Curated internal reference layer for topology, project descriptions, onboarding, and conventions.

Do not treat `:4401` as unconditional truth. Use it for orientation, then verify live operational claims against `:4400`, direct commands, or source files.

## 2) Exact Target Discipline

If the user gives any explicit target, treat it as mandatory:

- URL
- hash like `#card-openclaw-workspace-3`
- project/card/panel id
- path
- port

Do not silently switch to another card, panel, section, or project because it is visible by default.

Before acting, resolve:

1. what the requested target is
2. where the backing content actually lives
3. whether the task is editing:
   - a source file
   - a generated template
   - a backing API
   - a runtime-rendered UI only

## 3) Required Execution Sequence

For any docs-site modification:

1. Inspect the requested target
2. Identify the real storage layer
3. Make the edit at the source, not by scraping UI
4. Restart/reload the serving process if required
5. Verify the exact target changed
6. Only then report success

If step 2 is unresolved, do not proceed as if the update path is known.

## 4) Observed vs Inferred vs Verified

Always keep these separate:

- `observed`
  Directly seen in source, command output, or live page
- `inferred`
  Likely true from structure, but not yet proven
- `verified`
  Confirmed on the exact requested target after the action

Do not write “done”, “updated”, “added”, or “success” unless the requested effect is verified.

## 5) Working With :4401

When using the docs site:

- inspect the actual source file if the app is file-backed
- prefer source edits over brittle DOM injection or shell regex surgery
- if the app is served from a single template file, edit that source directly
- verify the relevant section, panel, card, or anchor after reload

Useful checks:

```bash
curl -s http://45.9.190.170:4401/ | grep -n "target-id"
rg -n "openclaw-workspace-3|agent-quickstart|Agent Operating Manual" /opt/project-docs/server.mjs
```

## 6) Working With :4400

Use `:4400` when the claim is about live system state:

- services
- PM2
- Docker
- ports
- uptime
- active instances
- runtime environment

Prefer:

```bash
curl -s http://127.0.0.1:4400/api/status
```

If `:4400` is unavailable, fall back to direct system evidence and say that explicitly.

## 7) Good Completion Behavior

Good:

- “I found the target in `/opt/project-docs/server.mjs`, edited it, restarted `project-docs`, and verified the exact section on `:4401`.”

Bad:

- “Task completed” after only reading the page
- claiming a PUT/API route exists without seeing it
- assuming the default visible card is the requested card

## 8) Skills To Pair With

Use this skill with:

- `docs-update` for doc maintenance workflow
- `doc-templates` when writing structured docs
- `api-reference` if there is a real backing API
- `curl-recipes` for live verification
- `token-awareness` to keep the inspection path tight
- `ux-ui-expert` if the docs presentation itself needs improvement

## 9) Checklist

- [ ] Exact target identified
- [ ] Backing storage layer identified
- [ ] `:4401` treated as reference, not blind truth
- [ ] `:4400` or equivalent live source checked for operational claims
- [ ] Source edited instead of brittle UI scraping
- [ ] Exact target verified after change
- [ ] Final answer distinguishes observed / inferred / verified
