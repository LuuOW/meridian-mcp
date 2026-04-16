---
name: database
description: Relational database authority — PostgreSQL, async ORM (SQLAlchemy 2 / asyncpg), Alembic schema migrations, Supabase Python and JS clients, query optimisation, index strategy, connection pooling, transaction patterns, and bulk operations across Python and Node stacks
keywords: ["database", "relational", "postgresql", "orm", "sqlalchemy", "alembic", "supabase", "python", "js", "node", "authority", "async", "asyncpg", "schema", "migrations", "clients", "query"]
orb_class: comet
---

# database

Authoritative reference for relational database work: connection pooling, async queries, migrations, and Supabase-specific patterns.

## 1) Async connection with asyncpg / SQLAlchemy 2

```python
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

engine = create_async_engine(
    "postgresql+asyncpg://user:pass@host/db",
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,   # drop dead connections before use
)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)

async def get_db():
    async with AsyncSessionLocal() as session:
        yield session
```

## 2) SQLAlchemy 2 Core style (preferred for high-throughput)

```python
from sqlalchemy import select, insert, update, delete, text

# SELECT with filter
stmt = select(Article).where(Article.published == True).order_by(Article.created_at.desc()).limit(20)
result = await session.execute(stmt)
rows = result.scalars().all()

# Bulk INSERT (ignore duplicates)
stmt = insert(Keyword).values(data).on_conflict_do_nothing(index_elements=['slug'])
await session.execute(stmt)
await session.commit()

# Raw SQL (last resort — prefer Core)
result = await session.execute(text("SELECT id FROM articles WHERE slug = :s"), {"s": slug})
```

## 3) Model definition pattern

```python
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy import String, DateTime, func
import uuid

class Base(DeclarativeBase):
    pass

class Article(Base):
    __tablename__ = "articles"

    id:         Mapped[uuid.UUID]  = mapped_column(primary_key=True, default=uuid.uuid4)
    slug:       Mapped[str]        = mapped_column(String(255), unique=True, index=True)
    title:      Mapped[str]        = mapped_column(String(500))
    published:  Mapped[bool]       = mapped_column(default=False)
    created_at: Mapped[datetime]   = mapped_column(server_default=func.now())
```

## 4) Alembic migrations

```bash
# Init (once per project)
alembic init alembic

# alembic/env.py — point at your models
from app.models import Base
target_metadata = Base.metadata

# Generate migration from model diff
alembic revision --autogenerate -m "add articles table"

# Apply / rollback
alembic upgrade head
alembic downgrade -1

# Check current revision
alembic current
alembic history --verbose
```

## 5) Supabase Python client

```python
from supabase import create_client

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

# Query
res = supabase.table("articles").select("*").eq("published", True).limit(20).execute()
rows = res.data

# Upsert
supabase.table("articles").upsert({"slug": slug, "title": title}, on_conflict="slug").execute()

# RPC (call a Postgres function)
res = supabase.rpc("get_citations_gap", {"domain": "keto"}).execute()
```

## 6) Supabase JS client (Astro / Next.js)

```ts
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(import.meta.env.PUBLIC_SUPABASE_URL, import.meta.env.PUBLIC_SUPABASE_ANON_KEY)

// Server-side (service key, in .server.ts files)
const { data, error } = await supabase
  .from('articles')
  .select('slug, title, published_at')
  .eq('published', true)
  .order('published_at', { ascending: false })
```

## 7) Query optimisation checklist

```sql
-- Add index for common filters
CREATE INDEX CONCURRENTLY idx_articles_published ON articles(published, created_at DESC);

-- Explain analyse before shipping slow queries
EXPLAIN (ANALYZE, BUFFERS) SELECT ...;

-- Partial index (only index published rows)
CREATE INDEX idx_articles_slug ON articles(slug) WHERE published = true;

-- Check table bloat
SELECT schemaname, tablename, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename))
FROM pg_tables ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC LIMIT 10;
```

## 8) Connection pool diagnostics

```python
# Log pool state
engine.pool.status()

# Force recycle on long-running processes (prevents stale connections after DB restart)
engine = create_async_engine(url, pool_recycle=3600, pool_pre_ping=True)
```

## 9) Transaction patterns

```python
# Explicit transaction (multiple ops, atomic)
async with session.begin():
    session.add(article)
    await session.execute(update(Domain).where(...).values(article_count=Domain.article_count + 1))
# auto-commits on exit, rolls back on exception

# Savepoints (nested transactions)
async with session.begin_nested():
    ...
```

## 10) Checklist — before shipping DB code

- [ ] `pool_pre_ping=True` on engine (prevents stale connection errors)
- [ ] `expire_on_commit=False` on session (prevents lazy-load after commit in async context)
- [ ] Indexes on all WHERE / ORDER BY columns used in hot paths
- [ ] Alembic migration generated and reviewed before deploying model changes
- [ ] No `SELECT *` in production — select only needed columns
- [ ] Bulk operations use `execute(insert(...).values(list))` not a loop
- [ ] Service key never exposed client-side (Supabase)
