---
name: ci-cd
description: CI/CD pipelines for GitHub Actions and Docker-based deployments — lint, test, build, push, deploy stages; environment secrets; branch-gated workflows; health-check rollbacks; and PM2/systemd service restarts
keywords: ["ci", "cd", "github", "actions", "docker", "pm2", "ci/cd", "pipelines", "docker-based", "deployments", "lint", "test", "build", "push", "deploy", "stages", "environment", "secrets", "branch-gated"]
orb_class: comet
---

# ci-cd

Practical CI/CD patterns for Python/FastAPI and Node/Astro/Next.js projects using GitHub Actions. Covers pipeline structure, secrets management, Docker image builds, staged deployments, and zero-downtime restarts.

## 1) Pipeline Mental Model

```
Code push → Lint/Type-check → Unit tests → Build image → Push to registry
                                                              ↓
                                            Deploy to VPS (pull + restart)
                                                              ↓
                                            Health check → rollback if fail
```

**Branch strategy:**
- `main` → production deploy
- `feature/*` / `development` → run tests only, no deploy
- `release/*` → staging deploy

## 2) Standard GitHub Actions Workflow

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: ["**"]
  pull_request:
    branches: [main, development]

jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.12"
          cache: "pip"

      - name: Install dependencies
        run: pip install -r requirements.txt -r requirements-dev.txt

      - name: Lint
        run: |
          ruff check app/ shared/ --output-format=github
          mypy app/ --ignore-missing-imports

      - name: Test
        env:
          TEST_DATABASE_URL: postgresql://postgres:postgres@localhost:5432/test_db
          MOCK_MODE: "true"
          JWT_SECRET_KEY: test-secret
        run: pytest tests/ -v --tb=short -m "not slow"

    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: test_db
        ports: ["5432:5432"]
        options: >-
          --health-cmd pg_isready
          --health-interval 5s
          --health-timeout 3s
          --health-retries 5
```

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    needs: []   # add lint-and-test job name here if in same file
    environment: production

    steps:
      - uses: actions/checkout@v4

      - name: Build and push Docker image
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: |
            ghcr.io/${{ github.repository }}:latest
            ghcr.io/${{ github.repository }}:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
        env:
          DOCKER_BUILDKIT: 1

      - name: Deploy to VPS
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd /opt/myapp
            docker pull ghcr.io/${{ github.repository }}:latest
            docker compose up -d --no-deps --build app
            sleep 5
            docker compose ps | grep "Up" || (echo "Deploy failed" && exit 1)
```

## 3) Secrets Management

**Never hardcode. Store in GitHub → Settings → Secrets:**

| Secret Name | What it holds |
|---|---|
| `VPS_HOST` | Server IP or hostname |
| `VPS_USER` | SSH username (e.g. `deploy`) |
| `VPS_SSH_KEY` | Private SSH key (Ed25519) |
| `GHCR_TOKEN` | GitHub Personal Access Token (read:packages) |
| `DATABASE_URL` | Production DB connection string |
| `JWT_SECRET_KEY` | Generated with `openssl rand -hex 32` |

**Generate deploy key:**
```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/deploy_key -N ""
# Add deploy_key.pub to VPS: ~/.ssh/authorized_keys
# Add deploy_key (private) to GitHub secrets as VPS_SSH_KEY
```

## 4) Node / Frontend Pipeline

```yaml
# .github/workflows/frontend.yml
jobs:
  build-frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
          cache-dependency-path: frontend/package-lock.json

      - run: npm ci
        working-directory: frontend

      - run: npm run lint
        working-directory: frontend

      - run: npm run test -- --run
        working-directory: frontend

      - run: npm run build
        working-directory: frontend
        env:
          VITE_API_BASE_URL: ${{ secrets.VITE_API_BASE_URL }}
```

## 5) PM2 Restart on Deploy (no Docker)

```bash
# deploy script on VPS:
#!/bin/bash
set -e
cd /opt/myapp

git fetch origin main
git reset --hard origin/main

# Python backend
source .venv/bin/activate
pip install -r requirements.txt --quiet
pm2 reload ecosystem.config.cjs --env production

# Frontend (Astro/Next)
cd frontend
npm ci --omit=dev
npm run build
pm2 reload ecosystem.config.cjs --only frontend
```

```js
// ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "api",
      script: ".venv/bin/uvicorn",
      args: "app.main:app --host 0.0.0.0 --port 9002",
      env_production: { NODE_ENV: "production", ENVIRONMENT: "production" },
    },
    {
      name: "frontend",
      script: "node",
      args: "dist/server/entry.mjs",
      cwd: "./frontend",
      env_production: { NODE_ENV: "production", PORT: "8080" },
    },
  ],
};
```

## 6) Docker Compose Deploy (zero-downtime)

```yaml
# docker-compose.prod.yml
services:
  app:
    image: ghcr.io/myorg/myapp:latest
    restart: unless-stopped
    env_file: .env.production
    ports: ["9002:9002"]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9002/health"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 15s
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:16
    restart: unless-stopped
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s

volumes:
  pgdata:
```

```bash
# Zero-downtime update on VPS:
docker compose -f docker-compose.prod.yml pull app
docker compose -f docker-compose.prod.yml up -d --no-deps app
```

## 7) Health Check + Rollback

```bash
# post-deploy health check with rollback:
PREVIOUS_TAG=$(docker inspect myapp_app --format '{{.Config.Image}}' 2>/dev/null || echo "")

docker compose up -d app

for i in $(seq 1 12); do
  sleep 5
  if curl -sf http://localhost:9002/health > /dev/null; then
    echo "Deploy healthy"
    exit 0
  fi
  echo "Attempt $i: not healthy yet..."
done

echo "Health check failed — rolling back"
if [ -n "$PREVIOUS_TAG" ]; then
  docker tag "$PREVIOUS_TAG" myapp:rollback
  docker compose up -d app
fi
exit 1
```

## 8) Database Migrations in CI

```yaml
- name: Run migrations
  run: |
    # Alembic (async SQLAlchemy)
    alembic upgrade head
    # or plain SQL
    psql "$DATABASE_URL" -f app/db/schema.sql
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

**Rule:** Migrations run before the new app container starts. Use `depends_on` with `condition: service_healthy` for DB readiness.

## 9) Checklist

- [ ] Lint + type-check runs on every push (all branches)
- [ ] Tests run with `MOCK_MODE=true` — no real API keys in CI
- [ ] Production deploy gated to `main` branch only
- [ ] All secrets in GitHub Actions secrets — never in workflow YAML
- [ ] Docker image tagged with both `:latest` and `:<git-sha>` for rollback
- [ ] `healthcheck:` defined on every service in docker-compose
- [ ] Migrations run before app container starts
- [ ] Deploy key is Ed25519 and scoped to one repo / one VPS
- [ ] `pm2 reload` (not `restart`) for zero-downtime restarts
