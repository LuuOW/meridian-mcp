---
name: unit-test
description: pytest + pytest-asyncio patterns for Python FastAPI services (fixtures, DB safety guards, mock mode, Celery eager, markers) and Vitest + Testing Library for React/TypeScript frontends — synthesized from lead-gen-engine and seo-geo-aeo-engine
---

# unit-test

Testing patterns for the Python/FastAPI + React/TypeScript stack. Covers pytest configuration, conftest fixtures, database safety guards, external API mocking, async tests, Celery eager mode, and Vitest for frontend.

## 1) pytest Configuration

```ini
# pytest.ini
[pytest]
testpaths = tests
addopts = -v --tb=short
markers =
    db: Database integration tests (require TEST_DATABASE_URL)
    unit: Pure unit tests (no DB, no network)
    celery: Celery task tests
    slow: Tests that call mocked external APIs
    asyncio: Async tests (pytest-asyncio)
```

```toml
# pyproject.toml alternative
[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-v --tb=short"
asyncio_mode = "auto"   # for pytest-asyncio: auto-detect async test functions
markers = [
    "db: Database integration tests",
    "unit: Pure unit tests",
    "slow: Mocked external API tests",
]

[tool.coverage.run]
source = ["app", "shared", "api"]
omit = ["tests/*", "*/migrations/*"]

[tool.coverage.report]
show_missing = true
fail_under = 70
```

## 2) conftest.py — Session Fixtures + DB Safety Guard

```python
# tests/conftest.py
import os
import pytest
from database.connection import ThreadedConnectionPool
from database.adapters.psycopg2_adapter import Psycopg2Adapter

# ── Safety guard ──────────────────────────────────────────────────────────
@pytest.fixture(scope="session", autouse=True)
def require_test_database():
    url = os.environ.get("TEST_DATABASE_URL", os.environ.get("DATABASE_URL", ""))
    if not url:
        pytest.fail("DATABASE_URL or TEST_DATABASE_URL must be set to run tests")
    if "test" not in url:
        pytest.fail(
            f"Refusing to run tests against non-test database.\n"
            f"URL must contain 'test': {url}"
        )

# ── Connection pool (session-scoped — created once) ───────────────────────
@pytest.fixture(scope="session")
def db_pool(require_test_database):
    url = os.environ["TEST_DATABASE_URL"]
    pool = ThreadedConnectionPool(minconn=1, maxconn=5, dsn=url)
    yield pool
    pool.closeall()

# ── Per-test DB adapter (auto-cleanup after each test) ────────────────────
@pytest.fixture
def db(db_pool):
    adapter = Psycopg2Adapter(db_pool)
    yield adapter
    # Cleanup: delete all rows in reverse FK order
    for table in ["sends", "prospects", "campaigns", "tenants", "users"]:
        adapter.execute_raw(f"DELETE FROM {table}")
    adapter.close()

# ── Domain fixtures ───────────────────────────────────────────────────────
@pytest.fixture
def sample_tenant(db):
    return db.insert("tenants", {"name": "Test Tenant", "domain": "test.example.com"})

@pytest.fixture
def sample_campaign(db, sample_tenant):
    return db.insert("campaigns", {
        "tenant_id": sample_tenant["id"],
        "name": "Test Campaign",
        "status": "active",
    })

@pytest.fixture
def sample_prospects(db, sample_campaign):
    prospects = [
        {"campaign_id": sample_campaign["id"], "email": f"lead{i}@example.com", "status": "new"}
        for i in range(3)
    ]
    return [db.insert("prospects", p) for p in prospects]
```

## 3) Unit Test Classes — Pure Function Testing

```python
# tests/test_normalise.py
import pytest
from agents.e2_brief import _normalise, _assemble_context

class TestNormalise:
    """Tests for brief normalization — no DB, no network."""

    @pytest.fixture
    def raw_brief(self):
        return {
            "title": "Best Keto Snacks",
            "meta_description": "x" * 200,   # deliberately too long
            "keywords": ["keto", "snacks", "low carb"],
            "word_count": 1500,
        }

    def test_meta_description_truncated(self, raw_brief):
        brief = _normalise(raw_brief)
        assert len(brief["meta_description"]) <= 155

    def test_title_preserved(self, raw_brief):
        brief = _normalise(raw_brief)
        assert brief["title"] == "Best Keto Snacks"

    def test_missing_word_count_defaults(self):
        brief = _normalise({"title": "T", "meta_description": "D", "keywords": []})
        assert brief["word_count"] == 1000   # default

class TestAssembleContext:
    def test_includes_all_required_keys(self):
        ctx = _assemble_context(domain="example.com", keywords=["keto"])
        for key in ("domain", "keywords", "persona", "brief_count"):
            assert key in ctx

    def test_keywords_truncated_to_limit(self):
        ctx = _assemble_context(domain="x.com", keywords=["k"] * 100)
        assert len(ctx["keywords"]) <= 20
```

## 4) External API Mocking (unittest.mock.patch)

```python
# tests/test_celery_tasks.py
import pytest
from unittest.mock import patch, MagicMock
from tasks.scraping import scrape_linkedin_reactions

@pytest.mark.slow
class TestScrapingTasks:

    @patch("shared.apify.run_actor")
    def test_scrape_reactions_calls_apify(self, mock_run):
        mock_run.return_value = [{"profile_url": "https://linkedin.com/in/foo", "name": "Foo Bar"}]
        result = scrape_linkedin_reactions(post_url="https://linkedin.com/posts/test")
        mock_run.assert_called_once()
        assert len(result) == 1
        assert result[0]["name"] == "Foo Bar"

    @patch("shared.exa.search")
    def test_exa_search_returns_results(self, mock_search):
        mock_search.return_value = {"results": [{"url": "https://example.com", "title": "Test"}]}
        results = scrape_social_mentions(query="keto diet 2024")
        assert results[0]["url"] == "https://example.com"
```

## 5) Mock Mode (env-based, no patch needed)

```python
# In each test module that exercises external APIs:
import os
import pytest

@pytest.fixture(autouse=True)
def enable_mock_mode(monkeypatch):
    monkeypatch.setenv("MOCK_MODE", "true")

# Now all functions that check is_mock_mode() will use fixture JSON
def test_search_organizations_mock():
    from shared.apollo import search_organizations
    results = search_organizations({"q": "saas"})
    assert isinstance(results, list)
    assert len(results) > 0   # fixture has data
```

## 6) Async Tests (pytest-asyncio)

```python
# tests/test_agents.py
import pytest
from httpx import AsyncClient
from app.main import app

@pytest.mark.asyncio
class TestE1Agent:

    async def test_trigger_returns_job_id(self):
        async with AsyncClient(app=app, base_url="http://test") as client:
            resp = await client.post("/agents/e1/run")
        assert resp.status_code == 200
        data = resp.json()
        assert "job_id" in data
        assert data["status"] == "queued"

    async def test_brief_normalization(self):
        from agents.e2_brief import _normalise
        brief = _normalise({"title": "T", "meta_description": "D" * 200, "keywords": []})
        assert len(brief["meta_description"]) <= 155

    @pytest.fixture
    def firecrawl_response(self):
        return {
            "status": "completed",
            "completed": 2,
            "data": [
                {"metadata": {"title": "Page 1"}, "markdown": "# Heading\nContent"},
                {"metadata": {"title": "Page 2"}, "markdown": "# Other\nContent"},
            ],
        }

    async def test_audit_merge_extracts_cwv(self, firecrawl_response):
        from agents.e1_crawl import _merge_audit
        audit = _merge_audit("example.com", firecrawl_response)
        assert "lcp_ms" in audit
        assert "page_count" in audit
```

## 7) Celery Eager Mode

```python
# tests/conftest.py — Celery in eager (synchronous) mode
import pytest
from celery_app import app as celery_app_instance

@pytest.fixture(scope="session")
def celery_app():
    celery_app_instance.conf.update(
        task_always_eager=True,       # Execute tasks synchronously
        task_eager_propagates=True,   # Raise exceptions instead of swallowing
        broker_url="memory://",       # No Redis needed
        result_backend="cache+memory://",
    )
    return celery_app_instance

# tests/test_celery_tasks.py
@pytest.mark.celery
def test_ping_task(celery_app):
    from tasks.smoke_test import ping
    result = ping.delay()
    assert result.get(timeout=5) == {"status": "ok"}
```

## 8) Integration Tests (DB + mocked external APIs)

```python
# tests/test_e2e_flow.py
import pytest

@pytest.mark.db
class TestOnboardingFlow:

    def test_create_campaign(self, db, sample_tenant):
        from database.db_campaigns import create_campaign
        campaign = create_campaign(db, tenant_id=sample_tenant["id"], name="My Campaign")
        assert campaign["id"] is not None
        assert campaign["status"] == "draft"

    def test_campaign_appears_in_list(self, db, sample_campaign):
        from database.db_campaigns import list_campaigns
        campaigns = list_campaigns(db)
        ids = [c["id"] for c in campaigns]
        assert sample_campaign["id"] in ids

@pytest.mark.db
class TestLeadSourcingFlow:

    def test_prospect_dedup_by_email(self, db, sample_campaign):
        from database.db_prospects import insert_prospect, get_prospect_by_email
        insert_prospect(db, campaign_id=sample_campaign["id"], email="dup@example.com")
        insert_prospect(db, campaign_id=sample_campaign["id"], email="dup@example.com")
        count = db.fetch_many("prospects", {"email": "dup@example.com"})
        assert len(count) == 1   # dedup enforced
```

## 9) Vitest + Testing Library (React frontend)

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['node_modules', 'src/test'],
    },
  },
});
```

```ts
// src/test/setup.ts
import '@testing-library/jest-dom';
```

```ts
// src/components/__tests__/CampaignCard.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CampaignCard from '../CampaignCard';

const mockCampaign = {
  id: 1,
  name: 'Test Campaign',
  status: 'active',
  prospect_count: 42,
};

describe('CampaignCard', () => {
  it('renders campaign name and status', () => {
    render(<CampaignCard campaign={mockCampaign} />);
    expect(screen.getByText('Test Campaign')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('calls onSelect when clicked', async () => {
    const onSelect = vi.fn();
    render(<CampaignCard campaign={mockCampaign} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('button'));
    expect(onSelect).toHaveBeenCalledWith(1);
  });
});
```

## 10) Run Commands

```bash
# Python — run all tests
pytest tests/ -v --tb=short

# Python — by marker
pytest -m unit                  # pure unit tests only
pytest -m db                    # integration tests (need TEST_DATABASE_URL)
pytest -m "not slow"            # skip mocked API tests
pytest -m "unit or celery"      # combine markers

# Python — with coverage
pytest tests/ --cov=app --cov=shared --cov-report=html

# Frontend — Vitest
npm run test                    # watch mode
npm run test -- --run           # CI mode (no watch)
npm run test -- --coverage      # with coverage

# Playwright (E2E)
npx playwright test             # all browsers
npx playwright test --headed    # visible browser
```

## 11) Checklist

- [ ] `require_test_database` fixture as `autouse=True, scope="session"` — prevent accidental production DB wipes
- [ ] DB URL must contain `"test"` — enforced in conftest
- [ ] Per-test cleanup deletes rows in reverse FK order (no TRUNCATE CASCADE surprises)
- [ ] External API calls mocked via `MOCK_MODE=true` or `@patch` — never real network in tests
- [ ] Celery tasks use `task_always_eager=True` in test config
- [ ] Async test functions marked `@pytest.mark.asyncio` (or `asyncio_mode = "auto"` in config)
- [ ] Use `AsyncClient(app=app)` from httpx for FastAPI integration tests — no real server needed
- [ ] `pytest.ini` markers documented — use them to split fast vs slow suites in CI
- [ ] Frontend tests co-located with components in `__tests__/` subdirs
- [ ] No `console.log` assertions — use `screen.getByText`, `toBeInTheDocument`, `toHaveBeenCalledWith`
