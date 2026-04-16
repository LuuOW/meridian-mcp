---
name: schema-authority
description: Single source of truth authority — define once in Pydantic / SQLModel / OpenAPI / Protobuf, generate TypeScript types, validators, docs, mocks, and contract tests from that canonical definition; schema registry patterns, spec-first API design, consumer-driven contract testing, and database-model alignment
keywords: ["schema", "authority", "single", "pydantic", "sqlmodel", "openapi", "protobuf", "typescript", "api", "contract", "source", "truth", "define", "once", "generate", "types", "validators"]
orb_class: trojan
---

# schema-authority

**Core principle**: one definition is the truth. Everything else — types, validators, docs, mocks, test fixtures, client SDKs — is derived from it. Never write the same shape twice.

If two places describe the same data, one of them is already wrong and you just don't know it yet.

## 1) Pydantic as canonical model → derive everything

```python
# models/article.py  ←  THE truth. Touch this file, regenerate everything else.
from pydantic import BaseModel, Field
from typing import Literal
from datetime import datetime
from uuid import UUID

class ArticleBase(BaseModel):
    title: str = Field(..., min_length=3, max_length=200)
    slug: str  = Field(..., pattern=r"^[a-z0-9-]+$")
    status: Literal["draft", "published", "archived"] = "draft"

class ArticleCreate(ArticleBase):
    body_markdown: str

class ArticleRead(ArticleBase):
    id: UUID
    created_at: datetime
    word_count: int

    model_config = {"from_attributes": True}   # ORM → Pydantic without extra code
```

FastAPI auto-generates the OpenAPI spec from these models — no separate spec file to maintain.

```python
# main.py
from fastapi import FastAPI
app = FastAPI(title="Content API", version="1.0.0")

@app.post("/articles", response_model=ArticleRead, status_code=201)
async def create_article(body: ArticleCreate, db: AsyncSession = Depends(get_db)):
    ...
```

Export the spec once, drive everything downstream from it:

```bash
# Export spec
curl http://localhost:8000/openapi.json > openapi.json

# Generate TypeScript types (frontend consumes these — never writes its own)
npx openapi-typescript openapi.json -o src/types/api.ts

# Generate a typed fetch client
npx openapi-fetch --input openapi.json --output src/lib/client
```

## 2) SQLModel: one class for ORM + API schema

```python
# SQLModel collapses Pydantic model + SQLAlchemy ORM model into one definition.
# The database schema IS the Pydantic schema. Drift is structurally impossible.
from sqlmodel import SQLModel, Field
from typing import Optional
from uuid import UUID, uuid4

class Article(SQLModel, table=True):
    id: UUID = Field(default_factory=uuid4, primary_key=True)
    title: str = Field(index=True, max_length=200)
    slug: str  = Field(unique=True)
    status: str = Field(default="draft")
    body_markdown: str

class ArticleCreate(SQLModel):           # request body — no id, no status
    title: str
    slug: str
    body_markdown: str

class ArticleRead(Article):              # response — full row
    pass
```

When `SQLModel` is not suitable (complex DB needs → SQLAlchemy + separate Pydantic):

```python
# Keep them aligned with a symmetry test — run in CI
def test_pydantic_orm_field_parity():
    orm_cols = {c.name for c in Article.__table__.columns}
    pydantic_fields = set(ArticleRead.model_fields.keys())
    assert orm_cols == pydantic_fields, f"Drift detected: {orm_cols ^ pydantic_fields}"
```

## 3) OpenAPI spec as contract — spec-first workflow

When the API is consumed by external clients, write the spec first, generate server stubs:

```yaml
# openapi.yaml  ←  authored by hand; server and client both generated from it
openapi: "3.1.0"
info:
  title: Content API
  version: 1.0.0
paths:
  /articles/{slug}:
    get:
      operationId: getArticle
      parameters:
        - name: slug
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/ArticleRead" }
        "404":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/ErrorResponse" }

components:
  schemas:
    ArticleRead:
      type: object
      required: [id, title, slug, status]
      properties:
        id:   { type: string, format: uuid }
        title: { type: string }
        slug:  { type: string }
        status: { type: string, enum: [draft, published, archived] }

    ErrorResponse:
      type: object
      required: [code, message]
      properties:
        code:    { type: string }
        message: { type: string }
```

```bash
# Generate Python server stubs
pip install openapi-python-client
openapi-python-client generate --path openapi.yaml

# Generate TypeScript client
npx openapi-typescript openapi.yaml -o src/types/api.ts
npx openapi-fetch --input openapi.yaml --output src/client
```

## 4) Contract testing — Schemathesis (property-based)

Schemathesis reads the spec and generates adversarial inputs automatically. It proves the server and the spec agree.

```bash
pip install schemathesis

# Run against live server
schemathesis run http://localhost:8000/openapi.json --checks all

# Run in CI against recorded cassette (no live server needed)
schemathesis run http://localhost:8000/openapi.json \
  --stateful=links \
  --hypothesis-max-examples=100 \
  --junit-xml=test-results/schemathesis.xml
```

```python
# Or embed in pytest
import schemathesis

schema = schemathesis.from_uri("http://localhost:8000/openapi.json")

@schema.parametrize()
def test_api_conforms_to_spec(case):
    response = case.call()
    case.validate_response(response)
```

## 5) Consumer-driven contracts — Pact

When multiple services consume an API, consumers specify the contract; the provider must satisfy all of them.

```python
# consumer test (frontend or downstream service)
import pytest
from pact import Consumer, Provider

pact = Consumer("ArticleUI").has_pact_with(Provider("ContentAPI"))

def test_get_article():
    (pact
     .given("article with slug 'hello-world' exists")
     .upon_receiving("a request for that article")
     .with_request("GET", "/articles/hello-world")
     .will_respond_with(200, body={
         "id":    pact.like("550e8400-e29b-41d4-a716-446655440000"),
         "title": pact.like("Hello World"),
         "slug":  "hello-world",
         "status": pact.term("published", r"^(draft|published|archived)$"),
     })
    )
    with pact:
        # call the real (mocked) provider
        resp = requests.get(f"{pact.uri}/articles/hello-world")
    assert resp.status_code == 200
```

```python
# provider verification (runs in the API's CI)
@pytest.fixture
def pact_verifier():
    verifier = Verifier(
        provider="ContentAPI",
        provider_base_url="http://localhost:8000",
    )
    output, _ = verifier.verify_with_broker(
        broker_url="https://your-pact-broker",
        publish_version="1.0.0",
    )
    assert output == 0
```

## 6) Schema registry for event-driven systems

When events flow through Kafka or Redis Streams, the event schema is the contract between producers and consumers. Register it once; validate both sides against it.

```python
# schemas/article_published.py  ←  canonical event schema
from pydantic import BaseModel
from datetime import datetime
from uuid import UUID

class ArticlePublishedEvent(BaseModel):
    event_id: UUID
    article_id: UUID
    slug: str
    published_at: datetime
    word_count: int

SCHEMA_VERSION = "1.0"
TOPIC = "articles.published"
```

```python
# producer — validates before publishing
async def publish_article_event(article: Article, bus: EventBus):
    event = ArticlePublishedEvent(
        event_id=uuid4(),
        article_id=article.id,
        slug=article.slug,
        published_at=datetime.utcnow(),
        word_count=len(article.body_markdown.split()),
    )
    # Pydantic validates here — invalid event never reaches the bus
    await bus.publish(ArticlePublishedEvent.TOPIC, event.model_dump())

# consumer — validates on receipt
async def handle_article_published(raw: dict):
    event = ArticlePublishedEvent.model_validate(raw)   # raises if schema drift
    await index_for_search(event)
```

Lightweight in-process registry for multi-service repos:

```python
# schema_registry.py
_registry: dict[str, type] = {}

def register(topic: str, schema: type):
    _registry[topic] = schema

def validate(topic: str, payload: dict):
    schema = _registry.get(topic)
    if schema is None:
        raise ValueError(f"No schema registered for topic: {topic!r}")
    return schema.model_validate(payload)

# register at startup
register(ArticlePublishedEvent.TOPIC, ArticlePublishedEvent)
register(ArticleArchivedEvent.TOPIC,  ArticleArchivedEvent)
```

## 7) Database schema alignment — model-first vs migration-first

**Model-first** (Prisma, SQLModel with `create_all`): the ORM model IS the migration. Only use this in greenfield projects or where you control all consumers.

**Migration-first** (Alembic): migrations are the truth; the ORM model must match them. Enforce alignment in CI:

```python
# tests/test_schema_alignment.py
from sqlalchemy import inspect, create_engine
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory

def test_no_pending_migrations():
    """Fail if ORM models and migration head diverge."""
    engine = create_engine(TEST_DATABASE_URL)
    config = Config("alembic.ini")
    script = ScriptDirectory.from_config(config)

    with engine.connect() as conn:
        context = MigrationContext.configure(conn)
        db_heads = set(context.get_current_heads())
        script_heads = set(script.get_heads())
        assert db_heads == script_heads, (
            f"Migration drift: DB is at {db_heads}, scripts head is {script_heads}"
        )
```

```bash
# In CI — fail fast if a PR adds a model change without a migration
alembic check   # exits non-zero if autogenerate would produce changes
```

## 8) Shared errors as truth

```python
# errors.py  ←  one place; imported by API layer, test fixtures, and client generator
from enum import Enum

class ErrorCode(str, Enum):
    NOT_FOUND        = "NOT_FOUND"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    UNAUTHORIZED     = "UNAUTHORIZED"
    CONFLICT         = "CONFLICT"
    RATE_LIMITED     = "RATE_LIMITED"

class AppError(BaseModel):
    code: ErrorCode
    message: str
    detail: dict | None = None
```

```yaml
# errors.yaml — exported from AppError; imported into openapi.yaml
# Never define error shapes in two places
```

## 9) Decision rules

| Situation | Truth source | Derive from it |
|---|---|---|
| API shape | Pydantic model | OpenAPI spec, TS types, mocks |
| DB schema | Alembic migration | ORM model must match |
| DB + API same shape | SQLModel | Both in one class |
| External contract | OpenAPI spec (hand-authored) | Server stubs, client SDK |
| Event shape | Pydantic + registry | Producer validates, consumer validates |
| Multiple consumers | Pact contracts | Provider CI verifies all |
| Error codes | Enum in code | Imported, never copied |

**Never derive in the wrong direction.** If you have an OpenAPI spec and you write Pydantic models by hand from it — you now have two truth sources. Generate one from the other.

## 10) Checklist

- [ ] Pydantic models are the only place where field names, types, and constraints are defined
- [ ] TypeScript types generated from OpenAPI spec — no hand-maintained type files
- [ ] `alembic check` runs in CI — fails if model/migration diverge
- [ ] Schemathesis (or equivalent) runs in CI against the live spec
- [ ] Event schemas registered and validated on both publish and consume
- [ ] Error codes defined as an enum — imported everywhere, not duplicated
- [ ] Pact contracts committed to a broker — provider CI verifies them on each deploy
- [ ] No copy-paste of schema shapes between services
