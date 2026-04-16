---
name: docker
description: Docker platform authority — image architecture, multi-stage builds, runtime security, networking models, volume strategies, container orchestration patterns, registry workflows, and production-grade containerization across Python, Node, and multi-service systems
---

# docker

Production containerization platform for Python/FastAPI, Node/Astro, and multi-service architectures. Covers the full lifecycle: image design, build pipelines, runtime configuration, security hardening, networking, storage, and operational observability. Independent of any specific cloud provider or orchestrator.

## Image Architecture

Multi-stage builds are the default. Single-stage images are only acceptable for local development throwaway containers.

```dockerfile
# Python service — minimal production image
FROM python:3.12-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.12-slim AS runtime
WORKDIR /app
RUN useradd -m -u 1000 appuser
COPY --from=builder /install /usr/local
COPY --chown=appuser:appuser . .
USER appuser
EXPOSE 9002
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "9002"]
```

```dockerfile
# Node/Astro service — separate build and static-serve stages
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev
COPY . .
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
RUN useradd -m -u 1000 nodeuser
COPY --from=builder --chown=nodeuser:nodeuser /app/dist ./dist
COPY --from=builder --chown=nodeuser:nodeuser /app/node_modules ./node_modules
COPY --from=builder --chown=nodeuser:nodeuser /app/package.json .
USER nodeuser
EXPOSE 8080
CMD ["node", "dist/server/entry.mjs"]
```

```dockerfile
# Distroless — for services with no shell requirement (maximum attack surface reduction)
FROM golang:1.22 AS builder
WORKDIR /app
COPY go.* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /bin/server ./cmd/server

FROM gcr.io/distroless/static-debian12
COPY --from=builder /bin/server /server
EXPOSE 8080
ENTRYPOINT ["/server"]
```

**Layer order rule:** dependencies before source. Least-changed layers at the top. `COPY . .` always last.

## .dockerignore

Every project needs one. Missing `.dockerignore` sends node_modules, .git, and .env to the build context — slowing builds and leaking secrets into image history.

```
.git
.env
.env.*
!.env.example
**/__pycache__
**/*.pyc
**/.pytest_cache
**/.mypy_cache
**/node_modules
**/dist
**/build
.venv
*.log
.DS_Store
.idea
.vscode
coverage/
*.test.ts
*.spec.ts
```

## Runtime Security

Security decisions happen at image build time, not at runtime.

```dockerfile
# 1. Never run as root
RUN useradd -m -u 1000 -s /bin/sh appuser
USER appuser

# 2. Read-only root filesystem — forces explicit tmpfs declarations
# (set in compose or docker run, not in Dockerfile)

# 3. Drop all capabilities, re-add only what's needed
# (set in compose security_opt)

# 4. No new privileges escalation
# (set in compose security_opt)
```

```yaml
# docker-compose security hardening
services:
  api:
    image: myapp:latest
    read_only: true                    # root filesystem read-only
    tmpfs:
      - /tmp
      - /app/cache
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE              # only if binding port < 1024
```

```bash
# Scan image for CVEs before push
docker scout cves myapp:latest
# or with trivy (more detailed)
trivy image myapp:latest
# Fail CI if critical CVEs found
trivy image --exit-code 1 --severity CRITICAL myapp:latest
```

## Networking Models

```yaml
# Isolate services into named networks — never put everything on the default bridge
networks:
  frontend:          # nginx + frontend containers
    driver: bridge
  backend:           # api + db + redis
    driver: bridge
  # services only on 'backend' are unreachable from 'frontend'

services:
  nginx:
    networks: [frontend, backend]   # gateway: both networks
  api:
    networks: [backend]             # not reachable from frontend directly
  db:
    networks: [backend]             # db only talks to api
```

```bash
# Inspect network topology
docker network ls
docker network inspect myapp_backend
# Check which containers are on a network
docker network inspect myapp_backend --format '{{range .Containers}}{{.Name}} {{end}}'
# Test connectivity between containers
docker exec myapp_api_1 curl -s http://db:5432   # use service name, not IP
```

```yaml
# Host network mode — for containers that must bind to host ports directly
# Use only for monitoring agents, not application services
services:
  node-exporter:
    image: prom/node-exporter:latest
    network_mode: host
    pid: host
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
```

## Volume Strategy

Choose the right volume type for each use case. Wrong choice causes data loss or performance problems.

```yaml
services:
  db:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data   # named volume — survives container removal

  app:
    volumes:
      - /opt/myapp:/app:ro               # bind mount — shared host directory (read-only)
      - /opt/myapp/.env:/app/.env:ro     # specific file bind mount

  worker:
    tmpfs:
      - /tmp                             # in-memory — wiped on stop, never persists

volumes:
  pgdata:                                # Docker manages location
```

| Type | Lifecycle | Use for |
|------|-----------|---------|
| Named volume | Persists until explicit `docker volume rm` | Databases, stateful services |
| Bind mount | Host filesystem controls | Shared repos, config files, development hot-reload |
| tmpfs | Container lifetime | Scratch space, temp uploads, secrets that must not touch disk |

```bash
# Volume operations
docker volume ls
docker volume inspect pgdata
docker volume rm pgdata                 # WARNING: deletes data
docker run --rm -v pgdata:/data alpine tar czf - /data > pgdata_backup.tar.gz
```

## Build Performance and Caching

```dockerfile
# Use BuildKit cache mounts for package managers (avoids re-downloading on every build)
# syntax=docker/dockerfile:1
FROM python:3.12-slim
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

FROM node:20-slim
RUN --mount=type=cache,target=/root/.npm \
    npm ci
```

```bash
# Enable BuildKit globally
export DOCKER_BUILDKIT=1

# Build with explicit cache source (for CI layer caching)
docker build \
  --cache-from ghcr.io/myorg/myapp:cache \
  --build-arg BUILDKIT_INLINE_CACHE=1 \
  -t ghcr.io/myorg/myapp:latest .

# Multi-platform builds (for ARM64 + AMD64 releases)
docker buildx create --use
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/myorg/myapp:latest \
  --push .
```

## Health Checks

Every stateful service and every long-running container needs a health check. `depends_on: condition: service_healthy` won't work without it.

```yaml
services:
  api:
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9002/health"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 30s     # grace period after start before health checks begin

  db:
    image: postgres:16
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"]
      interval: 5s
      timeout: 3s
      retries: 5

  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 2s
      retries: 3
```

```bash
# Check health status
docker inspect --format='{{.State.Health.Status}}' myapp_api_1
docker inspect --format='{{json .State.Health}}' myapp_api_1 | jq
```

## Secrets Management

```yaml
# docker-compose v3.9+ secrets (reads from file, not env)
services:
  api:
    secrets:
      - db_password
      - jwt_secret
    environment:
      DB_PASSWORD_FILE: /run/secrets/db_password

secrets:
  db_password:
    file: ./secrets/db_password.txt    # dev only — never commit this file
  jwt_secret:
    external: true                     # prod: managed externally (Vault, AWS SM, etc.)
```

```python
# Read secret from file inside container — never from env in production
def read_secret(name: str) -> str:
    path = f"/run/secrets/{name}"
    with open(path) as f:
        return f.read().strip()

DATABASE_PASSWORD = read_secret("db_password")
```

**Rules:**
- Secrets in `/run/secrets/` (tmpfs) — never written to disk layers
- Never `ENV SECRET_KEY=...` in Dockerfile — it appears in `docker history`
- Never `environment: SECRET_KEY: ${SECRET_KEY}` in compose for sensitive values — use `secrets:`

## Debugging and Observability

```bash
# Shell into running container
docker exec -it myapp_api_1 bash

# Shell into stopped or failing container (override entrypoint)
docker run -it --entrypoint bash myapp:latest

# Real-time logs
docker logs myapp_api_1 --tail 100 -f

# Structured log forwarding (add to compose)
services:
  api:
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

# Resource usage
docker stats --no-stream                # snapshot
docker stats                            # live

# Inspect layer sizes (find bloat)
docker history myapp:latest --human

# Copy file out of container (no exec needed)
docker cp myapp_api_1:/app/app.log ./app.log

# Diff container vs image filesystem (shows what's changed at runtime)
docker diff myapp_api_1
```

## Container-to-Host Communication

Pattern for containers that must trigger host-side actions (restarts, git pulls, migrations) without granting root access.

```bash
# Host setup: restricted deploy user
adduser --disabled-password --gecos "" container-agent
ssh-keygen -t ed25519 -C "container-to-host" -f /opt/keys/container_host_key -N ""
mkdir -p /home/container-agent/.ssh
# Force-command in authorized_keys — restricts to allowlisted commands only
echo 'command="/opt/scripts/agent-commands.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding ssh-ed25519 AAAA...' \
    >> /home/container-agent/.ssh/authorized_keys
chmod 700 /home/container-agent/.ssh && chmod 600 /home/container-agent/.ssh/authorized_keys
```

```bash
# /opt/scripts/agent-commands.sh
#!/bin/bash
case "$SSH_ORIGINAL_COMMAND" in
    "restart-api")    pm2 reload api ;;
    "run-migrations") cd /opt/myapp && .venv/bin/alembic upgrade head ;;
    "pull-repo")      cd /opt/myapp && git pull origin main ;;
    *)                echo "Unknown: $SSH_ORIGINAL_COMMAND"; exit 1 ;;
esac
```

```yaml
# compose — mount private key, expose host as hostname
services:
  agent:
    volumes:
      - /opt/keys/container_host_key:/run/secrets/host_key:ro
    extra_hosts:
      - "host.docker.internal:host-gateway"   # Linux Docker 20.10+
    environment:
      HOST_SSH_USER: container-agent
      HOST_IP: host.docker.internal
```

## Image Tagging and Rollback Strategy

```bash
# Always tag with both :latest and :<git-sha>
SHA=$(git rev-parse --short HEAD)
docker tag myapp:latest ghcr.io/myorg/myapp:latest
docker tag myapp:latest ghcr.io/myorg/myapp:${SHA}
docker push ghcr.io/myorg/myapp:latest
docker push ghcr.io/myorg/myapp:${SHA}

# Rollback: pull the sha-tagged image instead of :latest
docker pull ghcr.io/myorg/myapp:abc1234
docker tag ghcr.io/myorg/myapp:abc1234 myapp:latest
docker compose up -d --no-build
```

## Production Checklist

- [ ] Multi-stage Dockerfile — build artifacts not in final image
- [ ] Non-root user (`USER appuser`) in final stage
- [ ] `.dockerignore` excludes `.env`, `node_modules`, `.git`
- [ ] Production ports bound to `127.0.0.1:PORT`, not `0.0.0.0`
- [ ] Databases on named volumes, not bind mounts
- [ ] `read_only: true` + explicit `tmpfs` for writable scratch dirs
- [ ] `no-new-privileges:true` + `cap_drop: ALL` in security_opt
- [ ] `healthcheck:` on every stateful service
- [ ] Secrets at `/run/secrets/` — never in ENV or image history
- [ ] Images tagged with git SHA for rollback
- [ ] CVE scan in CI (`trivy image --exit-code 1 --severity CRITICAL`)
- [ ] Isolated named networks — no cross-contamination between service groups
- [ ] Container-to-host SSH uses restricted `authorized_keys` with command allowlist
