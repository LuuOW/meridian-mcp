---
name: env-management
description: Environment variable patterns for Python (python-dotenv, Pydantic BaseSettings) and TypeScript (VITE_, NEXT_PUBLIC_) projects — .env.example authorship, schema validation, mock/feature flags, and safe defaults — synthesized from lead-gen-engine and seo-geo-aeo-engine
keywords: ["env", "management", "environment", "python", "pydantic", "basesettings", "typescript", "variable", "patterns", "python-dotenv", "vite", "next", "public", "projects", "example", "authorship"]
orb_class: trojan
---

# env-management

Patterns for managing environment variables across Python/FastAPI backends and TypeScript/Next.js or Vite frontends. Synthesized from lead-gen-engine (python-dotenv + manual validation) and seo-geo-aeo-engine (Pydantic BaseSettings + LRU cache).

## 1) Python: Pydantic BaseSettings (preferred — seo-geo-aeo pattern)

```python
# core/config.py
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Database
    database_url: str
    postgres_user: str = "app"
    postgres_password: str = ""

    # Redis
    redis_url: str = "redis://localhost:6379/0"
    redis_password: str = ""

    # LLM providers — all optional (feature-flagged)
    openai_api_key: str = ""
    anthropic_api_key: str = ""
    moonshot_api_key: str = ""
    gemini_api_key: str = ""

    # Generic OpenAI-compatible provider (overrides specific providers when set)
    use_generic_llm: bool = False
    generic_llm_base_url: str = ""
    generic_llm_api_key: str = ""
    generic_llm_model: str = "gpt-4o"

    # External APIs
    serp_api_key: str = ""
    firecrawl_api_key: str = ""

    # App
    environment: str = "development"
    log_level: str = "INFO"
    debug: bool = False

    # Auth
    jwt_secret: str = "change-me-in-production"
    dashboard_username: str = "admin"
    dashboard_password: str = ""

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

@lru_cache
def get_settings() -> Settings:
    return Settings()
```

**Usage everywhere:**
```python
from core.config import get_settings

def my_func():
    s = get_settings()
    # s.database_url, s.openai_api_key, etc.
```

## 2) Python: python-dotenv + Manual Validation (lead-gen pattern)

```python
# shared/cli.py
from pathlib import Path
from dotenv import load_dotenv

def get_project_root() -> Path:
    return Path(__file__).parent.parent

def load_env() -> None:
    env_path = get_project_root() / ".env"
    if env_path.exists():
        load_dotenv(env_path)
```

```python
# shared/some_service.py — manual key guard
import os

def _get_api_key() -> str:
    key = os.environ.get("SERVICE_API_KEY", "").strip()
    if not key:
        raise EnvironmentError(
            "SERVICE_API_KEY is not set. "
            "Add it to your .env file. "
            "Get your key at: https://service.example.com/settings"
        )
    return key
```

**Call `load_env()` exactly once at startup** (in `main.py` or CLI entry point), never inside library code.

## 3) Mock / Feature Flags

```python
# shared/mock_helper.py
import os
import json
from pathlib import Path

FIXTURES_DIR = Path(__file__).parent / "fixtures"

def is_mock_mode() -> bool:
    return os.environ.get("MOCK_MODE", "").lower() == "true"

def load_fixture(name: str):
    with open(FIXTURES_DIR / name) as f:
        return json.load(f)
```

```python
# Usage in any external API function:
def search_leads(query: dict) -> list[dict]:
    if is_mock_mode():
        return load_fixture("leads.json")
    # ... real API call
```

**Service-specific mock overrides:**
```bash
MOCK_MODE=true              # Global mock mode
SPACESHIP_MOCK_MODE=true    # Override for one service only
```

## 4) .env.example — Source of Truth

Always keep `.env.example` exhaustive and up-to-date. Every key used in code must appear here.

```bash
# .env.example

# ── Database ────────────────────────────────────────────────────────────────
DATABASE_URL=postgresql://user:password@localhost:5432/myapp
# For async (asyncpg): DATABASE_URL=postgresql+asyncpg://user:pass@localhost/myapp

# ── Redis ───────────────────────────────────────────────────────────────────
REDIS_URL=redis://localhost:6379/0

# ── Auth ────────────────────────────────────────────────────────────────────
JWT_SECRET_KEY=change-me-in-production   # REQUIRED in prod — use `openssl rand -hex 32`
JWT_EXPIRE_MINUTES=480

# ── LLM Providers (only one required) ───────────────────────────────────────
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
MOONSHOT_API_KEY=...
# Generic OpenAI-compatible
USE_GENERIC_LLM=false
GENERIC_LLM_BASE_URL=https://api.openai.com/v1
GENERIC_LLM_API_KEY=
GENERIC_LLM_MODEL=gpt-4o

# ── External APIs ────────────────────────────────────────────────────────────
INSTANTLY_API_KEY=           # https://app.instantly.ai/settings/integrations
APOLLO_API_KEY=              # https://app.apollo.io/
SERP_API_KEY=                # https://serpapi.com/
FIRECRAWL_API_KEY=           # https://firecrawl.dev/

# ── Slack ────────────────────────────────────────────────────────────────────
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=
SLACK_CHANNEL=#alerts

# ── App ──────────────────────────────────────────────────────────────────────
ENVIRONMENT=development      # set to "production" in prod
LOG_LEVEL=INFO
DEBUG=false
MOCK_MODE=false              # true = use fixture JSONs instead of real APIs
```

## 5) Frontend: Vite Projects

```bash
# .env  (gitignored)
VITE_API_BASE_URL=http://localhost:9002

# .env.example  (committed)
VITE_API_BASE_URL=http://localhost:9002
```

```ts
// src/lib/config.ts — typed env access
const config = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:9002',
} as const;

export default config;
```

**Never access `import.meta.env` directly in components** — centralise in one config module.

## 6) Frontend: Next.js Projects

```bash
# .env.local  (gitignored)
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=secret
JWT_SECRET=change-me-in-production

# Publicly exposed to browser (prefix NEXT_PUBLIC_):
NEXT_PUBLIC_API_URL=http://localhost:9002
```

```ts
// lib/config.ts
export const serverConfig = {
  jwtSecret: process.env.JWT_SECRET!,
  dashboardUsername: process.env.DASHBOARD_USERNAME!,
  dashboardPassword: process.env.DASHBOARD_PASSWORD!,
};

export const publicConfig = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:9002',
};
```

## 7) Test Environment Isolation

```bash
# .env.test  (or set in CI)
DATABASE_URL=postgresql://user:pass@localhost:5432/myapp_test
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/myapp_test
REDIS_URL=redis://localhost:6379/15   # separate DB index
MOCK_MODE=true
JWT_SECRET_KEY=test-secret-not-for-production
```

```python
# tests/conftest.py — enforce test DB safety
import os, pytest

@pytest.fixture(scope="session", autouse=True)
def require_test_database():
    url = os.environ.get("TEST_DATABASE_URL", os.environ.get("DATABASE_URL", ""))
    assert "test" in url, (
        f"Refusing to run tests against non-test database.\n"
        f"DATABASE_URL must contain 'test': {url}"
    )
```

## 8) Production Security Rules

- `JWT_SECRET_KEY` must be generated with `openssl rand -hex 32` — never the default
- Never log env values — only log key names ("OPENAI_API_KEY is set: True")
- Optional keys default to `""` — guard with `if not key:` before use
- Required keys (DATABASE_URL, JWT_SECRET) must raise clearly at startup if missing
- In Pydantic BaseSettings, use `str = ""` for optional and `str` (no default) for required

```python
# Startup validation for required keys:
@asynccontextmanager
async def lifespan(app):
    s = get_settings()
    if s.is_production and s.jwt_secret == "change-me-in-production":
        raise RuntimeError("JWT_SECRET must be set in production")
    yield
```

## 9) Checklist

- [ ] `.env.example` committed with every key documented and grouped by service
- [ ] `.env` and `.env.local` in `.gitignore`
- [ ] Required keys have no default (raise at startup if missing)
- [ ] Optional keys default to `""` — code checks `if not value` before use
- [ ] All external API keys guarded by `_get_api_key()` or Pydantic field
- [ ] `MOCK_MODE` supported for local dev without real API credentials
- [ ] Test suite uses a separate DB + `MOCK_MODE=true`
- [ ] `JWT_SECRET_KEY` generated with `openssl rand -hex 32` in production
- [ ] Frontend env vars centralised in one `config.ts` — no inline `import.meta.env`
- [ ] `get_settings()` wrapped in `@lru_cache` — no repeated file reads
