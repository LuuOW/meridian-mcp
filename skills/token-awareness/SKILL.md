---
name: token-awareness
description: Token cost–benefit and energy analysis before implementing — estimate read/write overhead, compare full implementation vs targeted workaround, model signal-per-token efficiency, and apply the minimum-effective-change principle
---

# token-awareness

Token budgeting is an engineering discipline. Before writing code, estimate whether the approach is token-efficient. A 300-token workaround that solves 80% of the problem beats a 3000-token refactor that solves 100% — especially when the remaining 20% never materialises.

Tokens are also an energy metric:

- more tokens = more energy consumed
- more useful output per token = better efficiency
- if watt telemetry exists, token efficiency becomes comparable to throughput per watt

So token awareness is not just about staying under a context limit. It is about choosing higher-yield routes through the system.

## 1) The Core Question Before Every Task

> "What is the minimum change that fully satisfies the requirement?"

Not the cleanest change. Not the most extensible. The **minimum effective** one.

```
Approach A: refactor the whole module            → 2000 tokens to read + 800 to write
Approach B: add a 10-line guard in one function  → 200 tokens to read + 80 to write
                                                   ↑ 10× cheaper if B solves the problem
```

**Ask before opening files:**
1. Do I need to read the whole file, or just the function signature?
2. Can I solve this with a targeted edit rather than a rewrite?
3. Has the problem already been solved somewhere in the codebase?

## 2) Token Cost Estimates (rough rules of thumb)

| Operation | Approx. tokens consumed |
|---|---|
| Read a 100-line Python file | ~400 tokens |
| Read a 500-line file | ~2 000 tokens |
| Read `package.json` / `requirements.txt` | ~200–400 tokens |
| Read a `docker-compose.yml` (5 services) | ~600 tokens |
| Read an entire React component (200 lines) | ~800 tokens |
| Write a 50-line function | ~300 tokens |
| Write a 200-line module | ~1 200 tokens |
| Run a grep across 20 files | ~100 tokens (just the matches) |
| Read a large file you don't need | **pure waste** |

**High-waste patterns to avoid:**
- Reading a 600-line file when only one function is relevant → use `grep` first to locate the line, then `Read` with `offset + limit`
- Re-reading a file you already read in the same session → use recalled content
- Asking an agent to "explore the whole codebase" for a targeted fix → grep for the symbol instead
- Refactoring surrounding code not related to the task → scope creep inflates cost with no requirement value

## 2.5) Energy Interpretation

Use this framing when comparing approaches:

```text
energy_load        = estimated tokens spent
useful_signal      = decisions, code, or verified conclusions produced
energy_efficiency  = useful_signal / energy_load
```

If two approaches solve the same problem, prefer the one with the better `energy_efficiency`, not just the one that "feels more complete".

## 3) The Read-Before-You-Implement Rule

Never read more than necessary:

```bash
# Instead of: read the entire routes directory
# Do: grep for the specific thing first
grep -n "def login" /opt/myapp/api/routes/auth.py   # 1 line → you know exactly where to look
# Then: Read with offset + limit
# Read auth.py lines 45–80 instead of 1–350
```

```bash
# Instead of: read all 12 route files to find where a model is used
grep -rn "ProspectStatus" /opt/myapp/api/routes/   # shows you the 2 files that matter
```

**Read–write ratio target:** For a typical bug fix, aim for < 3× — i.e., if you write 100 tokens of code, you read at most ~300 tokens of context to write it.

## 4) The Workaround vs. Full-Implementation Decision Tree

```
Is the requirement well-defined and unlikely to expand?
  YES → minimum effective change (workaround/targeted fix)
  NO  → full implementation (requirements may change, invest upfront)

Is the workaround readable and maintainable?
  YES → use it, add a comment explaining why
  NO  → full implementation (future maintainability > current token cost)

Is the full implementation > 5× the token cost of the workaround?
  YES → workaround first, open a PENDING.md item for the full version
  NO  → doesn't matter much, pick the cleaner approach

Does the workaround introduce a security risk or correctness bug?
  YES → full implementation regardless of cost
  NO  → workaround is fine
```

**Example — "add a default value for missing config key":**
```python
# Workaround (30 tokens to write):
TIMEOUT = int(os.environ.get("REQUEST_TIMEOUT", "30"))

# Full implementation (300 tokens to write):
# Refactor all config into Pydantic BaseSettings, add field,
# update .env.example, update tests, update docs
```

The workaround is correct for now. The full implementation is a separate, planned task.

## 5) High-Waste Patterns to Flag Before Starting

| Pattern | Why it wastes tokens | Better approach |
|---|---|---|
| "Refactor while fixing a bug" | Doubles read scope, doubles write scope | Fix the bug, open a separate refactor task |
| "Add error handling everywhere" | Reads every call site | Add handling only at the failing boundary |
| "Update all tests after a change" | Forces reading all test files | Update only the tests that actually break |
| "Clean up unrelated code nearby" | Reads files irrelevant to the task | Leave it; note it in a comment at most |
| "Abstract into a utility function" | Reads all call sites to find commonality | Inline the logic; abstract when there are 3+ uses |
| Reading a file "just to understand context" without a specific question | Open-ended reads have no ceiling | Form a specific question first, then grep for the answer |

## 6) Scoping a Task to Minimum Tokens

Before starting, write down:
1. **What files will I need to read?** (list them)
2. **What will I write / edit?** (function names, line counts)
3. **Can I accomplish this with grep + targeted read instead of full read?**

```
Task: "Fix the 401 not redirecting to /login"

Files to read:
  - frontend/src/api/client.ts (interceptor is there — 150 lines, read lines 1–50)
  
Files to edit:
  - client.ts, lines 30–40 (add window.location.href = '/login')
  
Grep first:
  grep -n "401\|interceptor\|logout" frontend/src/api/client.ts
  → shows line 34 has the interceptor
  → read only lines 30–45
```

Estimated cost: 100 tokens read + 50 tokens write = 150 tokens total.
Without scoping: read the whole file (600 tokens) + write (50 tokens) = 650 tokens.
**4× waste avoided.**

## 7) When Full Implementation IS Worth the Cost

- **Security fix**: never cut corners on auth, input validation, SQL injection
- **Correctness bug**: a hack that silences an error without fixing it costs more tokens later (debugging the ghost)
- **The workaround will be read 100× more than it's written**: future readers pay the comprehension cost; write it clearly
- **The abstraction already exists and just needs to be used**: adopting an existing pattern costs less than inventing a new one-off
- **The task has stated requirements that the workaround doesn't meet**: scope is non-negotiable

## 8) The Comment Workaround Pattern

When choosing a targeted workaround over a full refactor, document the decision:

```python
# WORKAROUND: Using os.environ.get() directly here instead of BaseSettings
# because this module is called before the FastAPI app initialises and
# get_settings() hasn't been cached yet. Full fix: migrate to lifespan startup
# injection — tracked in PENDING.md.
SECRET_KEY = os.environ.get("JWT_SECRET_KEY", "change-me")
```

This costs ~30 extra tokens to write but saves the next session from re-deriving the context.

## 9) Checklist — Before Implementing

- [ ] Identified the specific file + function to change (not "explore the area")
- [ ] Used `grep` before `Read` to locate the exact lines needed
- [ ] Estimated read tokens vs write tokens — ratio < 5:1 for simple fixes
- [ ] Decided: workaround or full implementation (documented the decision if workaround)
- [ ] Not refactoring, cleaning up, or adding docs to code I didn't need to touch
- [ ] Not reading files that aren't directly on the change path
- [ ] If the full implementation is > 500 tokens: added it to `PENDING.md` with scope notes
- [ ] Workaround has a comment if the "right way" differs from the current approach
