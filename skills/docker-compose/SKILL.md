---
name: docker-compose
description: Multi-service docker-compose orchestration — service dependency ordering, profiles, override files, environment-specific configs, rolling restarts, and compose-based dev/prod parity patterns
keywords: ["docker", "compose", "multi", "multi-service", "docker-compose", "orchestration", "service", "dependency", "ordering", "profiles", "override", "files", "environment-specific", "configs", "rolling", "restarts", "compose-based", "dev/prod"]
orb_class: moon
---

# docker-compose

Production-grade `docker-compose.yml` authoring for multi-service applications. Covers dependency graphs, conditional service activation, config layering, and zero-downtime update strategies.

## Dependency Ordering with Health Checks

`depends_on` with `condition: service_healthy` prevents race conditions at startup. Without it, your app starts before the database is ready to accept connections.

```yaml
services:
  api:
    build: .
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
      migrations:
        condition: service_completed_successfully   # one-shot jobs

  db:
    image: postgres:16
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER"]
      interval: 5s
      timeout: 3s
      retries: 5

  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s

  migrations:
    image: myapp:latest
    command: ["alembic", "upgrade", "head"]
    depends_on:
      db:
        condition: service_healthy
    restart: "no"   # one-shot — do not restart after completion
```

## Compose Profiles (Selective Service Activation)

Profiles let you activate subsets of services without maintaining separate files.

```yaml
services:
  api:
    build: .
    # no profile — always started

  worker:
    build: .
    command: celery -A app worker
    profiles: [worker]         # only started with --profile worker

  flower:
    image: mher/flower
    profiles: [worker, debug]  # started with either --profile worker or --profile debug

  mailhog:
    image: mailhog/mailhog
    profiles: [debug]          # local email testing only
    ports:
      - "127.0.0.1:8025:8025"

  adminer:
    image: adminer
    profiles: [debug]
    ports:
      - "127.0.0.1:8080:8080"
```

```bash
# Start only core services
docker compose up -d

# Start core + worker profile
docker compose --profile worker up -d

# Start everything for local debugging
docker compose --profile worker --profile debug up -d
```

## Config Layering (Override Files)

Never duplicate between dev and prod configs. Use a base file + environment-specific overrides.

```yaml
# docker-compose.yml (base — shared between all environments)
services:
  api:
    image: ghcr.io/myorg/myapp:${TAG:-latest}
    restart: unless-stopped
    env_file: .env
    networks: [internal]

  db:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks: [internal]

networks:
  internal:
volumes:
  pgdata:
```

```yaml
# docker-compose.override.yml (dev — applied automatically in dev)
services:
  api:
    build: .                           # build from source in dev, not from image
    volumes:
      - .:/app                         # hot-reload: mount source
    ports:
      - "127.0.0.1:9002:9002"
    environment:
      DEBUG: "true"

  db:
    ports:
      - "127.0.0.1:5432:5432"         # expose DB to host tools in dev only
```

```yaml
# docker-compose.prod.yml (production — explicit, no auto-apply)
services:
  api:
    deploy:
      replicas: 2
      restart_policy:
        condition: on-failure
        max_attempts: 3
    ports: []                          # no ports exposed — nginx proxies internally
```

```bash
# Dev (auto-applies override.yml)
docker compose up -d

# Production (explicit file list)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

## Environment Variable Precedence

Compose resolves env vars in this order (highest wins):

```
1. Shell environment variables
2. --env-file flag
3. .env file in project directory
4. environment: block in compose file
5. env_file: block in compose file
```

```yaml
services:
  api:
    env_file:
      - .env                    # shared defaults
      - .env.local              # local overrides (gitignored)
    environment:
      PORT: "9002"              # always override PORT regardless of .env
      DATABASE_URL: "${DATABASE_URL}"   # required — fails fast if unset
```

```bash
# .env
DATABASE_URL=postgresql://app:secret@db:5432/myapp
REDIS_URL=redis://redis:6379/0
LOG_LEVEL=info

# .env.local (gitignored — developer-specific overrides)
LOG_LEVEL=debug
OPENAI_API_KEY=sk-...
```

## Rolling Restarts and Zero-Downtime Updates

```bash
# Rebuild and restart one service without touching others
docker compose up -d --no-deps --build api

# Force recreate even if image hasn't changed
docker compose up -d --force-recreate api

# Pull new image and restart (production update pattern)
docker compose pull api
docker compose up -d --no-deps api

# Wait for healthy before proceeding (scripted deploys)
docker compose up -d --no-deps api
docker compose run --rm wait-for-healthy
```

```bash
# Zero-downtime update via scale (requires load balancer)
docker compose up -d --scale api=4      # scale up
sleep 15                                # let new replicas warm up
docker compose up -d --scale api=2      # scale back to target
```

## Exec, Run, and Logs Patterns

```bash
# Run a one-off command in a running service's container
docker compose exec api bash
docker compose exec db psql -U app myapp

# Run a one-off command in a fresh container (does not affect running service)
docker compose run --rm api alembic upgrade head
docker compose run --rm api python manage.py createsuperuser

# Logs
docker compose logs api --tail 100 -f
docker compose logs --tail 50 -f          # all services, interleaved
docker compose logs --since 30m api       # last 30 minutes
```

## Common Mistakes

- Using `depends_on` without `condition: service_healthy` — the dependent service starts before DB/Redis is ready
- Committing `.env` or `.env.local` — use `.env.example` as template, keep real `.env` in `.gitignore`
- Exposing database ports in production (`5432:5432`) — only expose in dev override file
- Using `restart: always` on one-shot migration containers — use `restart: "no"` for jobs that should run once
- Forgetting `--no-deps` when rebuilding one service — without it, compose also recreates dependencies
