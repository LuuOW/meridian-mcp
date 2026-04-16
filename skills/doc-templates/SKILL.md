---
name: doc-templates
description: Reusable documentation fragments and micro-patterns — ADR templates, runbook blocks, incident post-mortem skeletons, PR description stubs, and changelog entry formats
keywords: ["doc", "templates", "reusable", "adr", "pr", "documentation", "fragments", "micro-patterns", "runbook", "blocks", "incident", "post-mortem", "skeletons", "description", "stubs", "changelog", "entry"]
orb_class: comet
---

# doc-templates

Copy-paste fragments for recurring documentation structures. Each template is self-contained and opinionated. Pick the block you need; don't combine templates for the same page.

## ADR (Architecture Decision Record)

```markdown
# ADR-{NNN}: {Short imperative title}

**Date:** YYYY-MM-DD  
**Status:** Proposed | Accepted | Deprecated | Superseded by ADR-{NNN}  
**Deciders:** @handle1, @handle2  

## Context

What is the situation that forces this decision? What constraints exist?
(1–3 paragraphs. No solution here — only problem framing.)

## Decision

We will {concrete action verb} {what}.

## Consequences

**Positive:**
- …

**Negative / trade-offs:**
- …

**Neutral:**
- …

## Alternatives Considered

| Option | Why rejected |
|--------|-------------|
| … | … |
```

## Runbook Block

```markdown
## Runbook: {System Name} — {Failure Mode}

**Severity:** SEV-1 | SEV-2 | SEV-3  
**Owner:** @team-name  
**Last tested:** YYYY-MM-DD  

### Symptoms
- Alert name: `{AlertName}` in Grafana / PagerDuty
- Observable user impact: …

### Immediate Triage (< 5 min)

1. Check service health: `curl -s https://api.acme.io/health | jq`
2. Check recent deploys: `gh run list --workflow deploy.yml --limit 5`
3. Tail logs: `kubectl logs -n production -l app=acme-api --tail=200`

### Remediation

#### Option A: Rollback last deploy
```bash
gh workflow run rollback.yml -f version=$(git describe --tags HEAD~1)
```

#### Option B: Scale up replicas
```bash
kubectl scale deployment acme-api -n production --replicas=6
```

### Escalation

If not resolved in 30 min → page @on-call-lead via PagerDuty policy `P_ACME_PROD`.

### Post-Incident

Open a post-mortem within 48 hours. Link: [post-mortem template](#post-mortem).
```

## Post-Mortem Skeleton

```markdown
# Post-Mortem: {Incident Title}

**Date:** YYYY-MM-DD  
**Duration:** HH:MM – HH:MM UTC ({N} hours)  
**Severity:** SEV-{N}  
**Author:** @handle  
**Reviewers:** @handle1, @handle2  

## Summary

One paragraph. What broke, for how long, who was affected, root cause in one sentence.

## Impact

| Metric | Value |
|--------|-------|
| Users affected | … |
| Requests failed | … |
| Revenue impact | … |
| SLA breach | Yes / No |

## Timeline (UTC)

| Time | Event |
|------|-------|
| HH:MM | Alert fired: `{AlertName}` |
| HH:MM | On-call paged |
| HH:MM | Root cause identified |
| HH:MM | Mitigation applied |
| HH:MM | Service fully restored |

## Root Cause

What was the technical root cause? (Not "human error" — trace to the system property that allowed the error.)

## Contributing Factors

- …

## What Went Well

- …

## Action Items

| Action | Owner | Due |
|--------|-------|-----|
| Add alert for X | @handle | YYYY-MM-DD |
| Improve runbook section Y | @handle | YYYY-MM-DD |
| Fix root cause: Z | @handle | YYYY-MM-DD |

## Lessons Learned

…
```

## CHANGELOG Entry Format

Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) strictly. Use this block per release.

```markdown
## [2.4.0] — 2026-03-15

### Added
- `GET /widgets` now accepts `status` query param to filter by lifecycle state (#412)
- `Retry-After` header on all 429 responses (#398)

### Changed
- Default page size increased from 10 to 20 (#421)

### Deprecated
- `GET /v2/legacy-widgets` — will be removed in v3.0.0. Use `GET /widgets` instead.

### Removed
- Nothing removed this release.

### Fixed
- Widget `updated_at` timestamp was not updating on partial PATCH (#389)

### Security
- Rotated signing key used for export tokens; existing tokens remain valid until expiry.

[2.4.0]: https://github.com/acme/acme-api/compare/v2.3.1...v2.4.0
```

## PR Description Stub

```markdown
## What

One sentence. What does this PR do?

## Why

One sentence. Why is this change needed?

## How

- Bullet: key implementation choice #1
- Bullet: key implementation choice #2

## Testing

- [ ] Unit tests added / updated
- [ ] Integration tests pass locally
- [ ] Tested against staging (`make test-staging`)

## Screenshots (if UI change)

| Before | After |
|--------|-------|
| …      | …     |

## Checklist

- [ ] No debug code left in
- [ ] Docs updated (if user-facing change)
- [ ] CHANGELOG entry added
- [ ] Feature flag needed? (yes/no)
```

## README Skeleton

```markdown
# {Project Name}

> One-sentence description of what this does and for whom.

[![CI](https://github.com/org/repo/actions/workflows/ci.yml/badge.svg)](…)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

## Quickstart

```bash
# Minimum viable commands to get something working
git clone https://github.com/org/repo
cd repo
make install
make dev
```

Open http://localhost:3000.

## Requirements

- Node 20+
- PostgreSQL 16+
- (optional) Docker, for containerized local setup

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | yes | – | Postgres connection string |
| `SECRET_KEY` | yes | – | JWT signing secret |
| `LOG_LEVEL` | no | `info` | One of: debug, info, warn, error |

Copy `.env.example` → `.env` and fill in required values.

## Development

```bash
make dev        # Start dev server with hot reload
make test       # Run unit + integration tests
make lint       # Run linter
make build      # Production build
```

## Deployment

See [docs/guides/deployment.md](docs/guides/deployment.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache 2.0 — see [LICENSE](LICENSE).
```

## API Endpoint Doc Block (inline, non-OpenAPI)

For internal wikis or Notion pages where OpenAPI is overkill.

```markdown
### `GET /widgets/{id}`

Returns a single widget by ID.

**Auth:** Bearer token required  
**Rate limit:** 1000/min

#### Path Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Widget UUID (prefix `wgt_`) |

#### Query Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `expand` | string | – | Comma-separated relations to embed: `owner`, `tags` |

#### Response `200 OK`

```json
{
  "id": "wgt_01j8k9abc",
  "name": "My Widget",
  "status": "active",
  "created_at": "2026-01-15T09:00:00Z"
}
```

#### Errors

| Code | HTTP | When |
|------|------|------|
| `NOT_FOUND` | 404 | Widget does not exist or belongs to another account |
| `UNAUTHORIZED` | 401 | Token missing or expired |
```

## Common Mistakes

- Skipping the **Why** section in ADRs — six months later, nobody remembers the constraint that drove the decision
- Using "we" in post-mortems as a blame shield — use passive voice *or* specific system names, not vague collective pronouns
- Writing CHANGELOG entries that mirror git commit messages — CHANGELOG is for humans reading release notes, not for git log consumers
- Leaving placeholder text (`{N}`, `@handle`) in merged docs — add a CI lint rule: `grep -r '{NNN}\|@handle' docs/ && exit 1`
- Mixing ADR status "Proposed" with "Accepted" in the same file — status is a point-in-time fact, update it in the same commit that changes the decision
