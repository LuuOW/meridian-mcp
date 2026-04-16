---
name: docs-update
description: Rapidly catch up on any codebase by reading only .md files first — orientation protocol, what each doc type reveals, how to ask targeted follow-up questions, and how to keep docs in sync with code changes
keywords: ["docs", "update", "rapidly", "catch", "codebase", "reading", "only", "files", "first", "orientation", "protocol", "doc", "type", "reveals", "ask", "targeted", "follow-up"]
orb_class: planet
---

# docs-update

How to get productive in an unfamiliar (or returning) codebase as fast as possible by reading structured documentation before touching any code. Also covers keeping docs current so the next session costs fewer tokens.

## 1) The MD-First Orientation Protocol

When entering a repo cold, read docs in this order — **stop as soon as you have enough context for the task:**

```
1. README.md          ← what the project is, how to run it
2. ARCHITECTURE.md    ← system topology, agent/service boundaries
3. PENDING.md         ← what's disabled, what's blocked, what's planned
4. CLAUDE.md          ← AI-specific instructions and constraints
5. docs/*.md          ← deep dives on specific subsystems
6. CHANGELOG.md       ← what changed recently (last 5 entries)
7. <subdir>/README.md ← module-level context (check if it exists)
```

**Read code only when docs leave a specific question unanswered.**

```bash
# Find all .md files in the repo (sorted by size — larger = more useful)
find /opt/myrepo -name "*.md" -not -path "*node_modules*" -not -path "*.git*" \
  | xargs wc -l 2>/dev/null | sort -rn | head -20
```

## 2) What Each Doc Type Reveals

| File | What to extract |
|---|---|
| `README.md` | Stack, quick-start commands, port numbers, env setup |
| `ARCHITECTURE.md` | Service names, data flows, which agent does what |
| `PENDING.md` | Disabled features (don't fix what's intentionally off), blockers, credentials needed |
| `CLAUDE.md` | Constraints the AI must follow, naming conventions, off-limits areas |
| `CHANGELOG.md` | Recent breakage, recently added features, migration notes |
| `.env.example` | Every external dependency (API keys = external services used) |
| `Makefile` | Runnable commands the team actually uses day-to-day |
| `docker-compose.yml` | Services, ports, volumes — the runtime topology |
| `package.json` / `pyproject.toml` | Exact dependencies and versions |
| `pytest.ini` / `vitest.config.ts` | How tests are structured and run |

## 3) Targeted Follow-Up Questions After Reading Docs

After the MD pass, if the task still needs clarification, read **one specific file** rather than exploring broadly:

```
"The README says the API runs on :9002 — so I read api/main.py to see the routes."
"PENDING.md says email capture is disabled — so I read email-capture.php to understand the guard."
"ARCHITECTURE.md mentions an event bus — so I read core/redis.py to see the channel names."
```

**Never** read the whole `src/` tree to answer a question that docs already answer.

## 4) Detecting Staleness — When Docs Lie

Docs go stale. Before trusting a doc claim, cross-check:

```bash
# When was this doc last touched vs the code it describes?
git log --oneline -5 -- ARCHITECTURE.md
git log --oneline -5 -- app/core/

# Does the doc mention a file that no longer exists?
grep -oE '`[^`]+\.py`' ARCHITECTURE.md | sed "s/\`//g" | while read f; do
  [ -f "$f" ] || echo "MISSING: $f"
done

# Does the port in README match docker-compose?
grep -E "port|PORT" README.md docker-compose.yml
```

If a doc is more than 30 commits behind the code it describes, treat it as advisory only.

## 5) What to Write After Making a Change

After any non-trivial change, update docs in the same commit:

| Change type | Doc to update |
|---|---|
| New feature added | `README.md` (if user-visible), `CHANGELOG.md` |
| Feature enabled (was in PENDING.md) | Remove from `PENDING.md`, add to `README.md` |
| New env variable added | `.env.example` + relevant section in `README.md` |
| New service / agent added | `ARCHITECTURE.md` |
| API endpoint added or changed | `docs/api.md` or inline OpenAPI description |
| New npm/pip dependency | No doc needed — `package.json`/`requirements.txt` are self-documenting |
| Breaking change | `CHANGELOG.md` with migration notes |

```bash
# Good commit — docs and code together:
git add src/integrations/ringba.php wp-content/themes/keto-and-healthy/inc/integrations.php
git add PENDING.md README.md
git commit -m "feat: enable Ringba call tracking — remove from PENDING, document setup"
```

## 6) PENDING.md as a Living Contract

`PENDING.md` is the most valuable doc in a project because it explicitly captures **intentional incompleteness.** Keep it accurate.

```markdown
## Feature Name

**Status:** Disabled / In Progress / Blocked on: <dependency>
**Files affected:**
- `path/to/file.py` — what the stub does
**To enable:**
1. Step one (credential, config, etc.)
2. Step two
**ETA / Owner:** <if known>
```

**When enabling a pending feature:**
1. Delete its section from `PENDING.md`
2. Add a one-liner to `README.md` under the relevant section
3. Add to `CHANGELOG.md`: `## [unreleased] — feat: enabled X`

## 7) ARCHITECTURE.md Template (write once, update cheaply)

```markdown
# Architecture

## Services

| Service | Port | Description |
|---|---|---|
| FastAPI API | 9002 | Core backend, JWT auth |
| Astro frontend | 8080 | SSR frontend |
| PostgreSQL | 5432 | Primary data store |
| Redis | 6379 | Job queues, pub/sub |

## Data Flow

1. User → Nginx (443) → Frontend (:8080)
2. Frontend → API (:9002) via Bearer token
3. API → PostgreSQL for persistence
4. API → Redis to enqueue Celery tasks
5. Celery workers → External APIs (Apollo, Instantly, etc.)

## Agent Pipeline (if applicable)

E1 (crawl) → E2 (brief) → E3 (entity) → E2.5 (write) → E6 (publish)
                                   ↑ Redis pub/sub ↑

## Key Files

- `app/main.py` — FastAPI entry point
- `app/core/config.py` — All env vars (Pydantic BaseSettings)
- `app/agents/` — One file per autonomous agent
- `docker-compose.yml` — Full service topology
```

## 8) The Re-Entry Checklist (returning after days/weeks away)

```bash
# 1. What changed while I was gone?
git log --oneline -20
git diff HEAD~10 --stat

# 2. Any new env vars?
git diff HEAD~10 -- .env.example

# 3. Any new pending items?
cat PENDING.md

# 4. Are services running?
docker compose ps
pm2 status

# 5. Any failing tests?
pytest tests/ -m unit --tb=line -q
```

This sequence costs ~5 minutes and gives a complete picture without reading any source code.

## 9) Checklist

- [ ] `README.md` has: what it is, how to run, port numbers, env setup steps
- [ ] `PENDING.md` exists and lists every intentionally disabled feature
- [ ] `ARCHITECTURE.md` exists for any multi-service project
- [ ] `.env.example` has every key used in code, grouped and commented
- [ ] Doc updates committed in the **same commit** as the code change they describe
- [ ] `CHANGELOG.md` updated for every feature-complete or breaking change
- [ ] Docs cross-checked against code every 20+ commits (grep for missing files)
- [ ] New team members (or new AI sessions) can orient using only `.md` files
