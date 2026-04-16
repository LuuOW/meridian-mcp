---
name: docker-registry
description: Container image registry workflows — GHCR, Docker Hub, and private registry auth, tagging strategies, CI push pipelines, image pruning, and multi-platform manifest publishing
keywords: ["docker", "registry", "container", "ghcr", "hub", "ci", "image", "workflows", "private", "auth", "tagging", "strategies", "push", "pipelines", "pruning", "multi-platform"]
orb_class: comet
---

# docker-registry

Production patterns for pushing, pulling, tagging, and managing container images in registries. Covers GitHub Container Registry (GHCR), Docker Hub, and self-hosted registries.

## Tagging Strategy

A good tagging strategy enables rollback, traceability, and cache reuse.

```bash
SHA=$(git rev-parse --short HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD | sed 's|/|-|g')
TAG_LATEST="ghcr.io/myorg/myapp:latest"
TAG_SHA="ghcr.io/myorg/myapp:${SHA}"
TAG_BRANCH="ghcr.io/myorg/myapp:${BRANCH}"

# Build once, tag multiple times
docker build -t "$TAG_LATEST" .
docker tag "$TAG_LATEST" "$TAG_SHA"
docker tag "$TAG_LATEST" "$TAG_BRANCH"

# Push all tags
docker push "$TAG_LATEST"
docker push "$TAG_SHA"
docker push "$TAG_BRANCH"
```

| Tag | Pattern | Use |
|-----|---------|-----|
| `:latest` | Always current `main` | Default pull for deployments |
| `:<git-sha>` | `abc1234` | Immutable — use for rollback |
| `:<branch>` | `feature-auth` | PR preview environments |
| `:<semver>` | `v2.4.1` | Release pinning in external consumers |

## GitHub Container Registry (GHCR)

```yaml
# .github/workflows/build-push.yml
name: Build and Push

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}   # e.g. myorg/myapp

jobs:
  build-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - uses: actions/checkout@v4

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}   # no extra secret needed

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=sha,prefix=
            type=ref,event=branch
            type=raw,value=latest,enable=${{ github.ref == 'refs/heads/main' }}

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: ${{ github.event_name == 'push' }}   # don't push on PRs
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

## Docker Hub

```yaml
      - name: Log in to Docker Hub
        uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}   # use Access Token, not password
```

```bash
# Local login
docker login ghcr.io -u USERNAME --password-stdin < ~/.ghcr_token
docker login -u USERNAME --password-stdin < ~/.dockerhub_token   # Docker Hub
```

## Pulling in Deployment (VPS)

```bash
# On the VPS — authenticate once per machine
echo "$GHCR_TOKEN" | docker login ghcr.io -u USERNAME --password-stdin

# Deploy script — pull + restart with zero downtime
#!/bin/bash
set -e
IMAGE="ghcr.io/myorg/myapp:latest"

docker pull "$IMAGE"
docker compose -f /opt/myapp/docker-compose.yml pull
docker compose -f /opt/myapp/docker-compose.yml up -d --no-deps api
echo "Deployed $(docker inspect --format='{{index .RepoDigests 0}}' $IMAGE)"
```

```bash
# Store credentials for non-interactive pulls
# /root/.docker/config.json is auto-updated by docker login
# For systemd/cron jobs that run as root, this works automatically after login
cat ~/.docker/config.json   # verify auth entry exists for ghcr.io
```

## Self-Hosted Registry

```yaml
# docker-compose.yml — run a private registry
services:
  registry:
    image: registry:2
    restart: unless-stopped
    ports:
      - "127.0.0.1:5000:5000"
    volumes:
      - registry-data:/var/lib/registry
      - ./registry-config.yml:/etc/docker/registry/config.yml:ro
    environment:
      REGISTRY_AUTH: htpasswd
      REGISTRY_AUTH_HTPASSWD_REALM: "Registry Realm"
      REGISTRY_AUTH_HTPASSWD_PATH: /auth/htpasswd

volumes:
  registry-data:
```

```bash
# Generate htpasswd credentials
docker run --rm --entrypoint htpasswd httpd:2 -Bbn myuser mypassword > auth/htpasswd

# Push to self-hosted
docker tag myapp:latest localhost:5000/myapp:latest
docker push localhost:5000/myapp:latest

# List registry contents
curl -s http://localhost:5000/v2/_catalog | jq
curl -s http://localhost:5000/v2/myapp/tags/list | jq
```

## Image Pruning and Retention

```bash
# Remove images older than 7 days from the local daemon
docker image prune -a --filter "until=168h" -f

# Remove only dangling images (untagged — safe, no prompts)
docker image prune -f

# Full cleanup (WARNING: removes stopped containers + networks + dangling volumes)
docker system prune -f

# Check what would be removed without doing it
docker system prune --dry-run
```

```bash
# GHCR retention — delete old package versions via GitHub API
# List versions
gh api /user/packages/container/myapp/versions --paginate | jq '.[].id'

# Delete a specific version
gh api --method DELETE /user/packages/container/myapp/versions/12345678

# Delete all untagged versions (dangling digests) via gh CLI + jq
gh api /user/packages/container/myapp/versions --paginate \
  | jq '.[] | select(.metadata.container.tags | length == 0) | .id' \
  | xargs -I{} gh api --method DELETE /user/packages/container/myapp/versions/{}
```

## Multi-Platform Manifests

```bash
# Build and push for both AMD64 and ARM64 in one command
docker buildx create --name multiplatform --use
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/myorg/myapp:latest \
  --push .

# Inspect the manifest (verify both platforms are present)
docker buildx imagetools inspect ghcr.io/myorg/myapp:latest
```

## Rollback by SHA

```bash
# Find the SHA you want to roll back to (from CI logs or git log)
ROLLBACK_SHA="abc1234"
IMAGE="ghcr.io/myorg/myapp"

# Pull the specific SHA-tagged image
docker pull "${IMAGE}:${ROLLBACK_SHA}"

# Re-tag as latest on the server
docker tag "${IMAGE}:${ROLLBACK_SHA}" "${IMAGE}:latest"

# Restart with the rolled-back image (no re-pull needed)
docker compose up -d --no-deps --no-build api
```

## Common Mistakes

- Pushing `:latest` only — without SHA tags there is no rollback path
- Using Docker Hub personal access tokens stored in CI as plaintext — use GitHub Actions secrets and `GITHUB_TOKEN` for GHCR instead
- Forgetting `permissions: packages: write` in the GitHub Actions job — the default `GITHUB_TOKEN` has no package write access without this
- Running `docker system prune -a` in production — it removes all images not currently used by a running container, including the rollback image
- Not pinning the registry image (`registry:2`) — use a specific version tag for self-hosted registries to prevent unexpected upgrades
