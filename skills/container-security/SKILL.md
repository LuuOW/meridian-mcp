---
name: container-security
description: Container runtime security — non-root users, read-only filesystems, capability dropping, secrets hygiene, image scanning, supply-chain verification, and runtime policy enforcement
keywords: ["container", "security", "runtime", "non-root", "users", "read-only", "filesystems", "capability", "dropping", "secrets", "hygiene", "image", "scanning", "supply-chain", "verification"]
orb_class: moon
---

# container-security

Security hardening for containerized workloads at every layer: image build time, runtime configuration, secrets handling, and supply-chain verification. Applied in docker-compose, Kubernetes, or bare Docker.

## Non-Root User (Always)

Running as root inside a container is a container escape waiting to happen. Enforce non-root at image build time.

```dockerfile
# Create a locked-down user — no home dir (unless needed), no shell, known UID
RUN addgroup --system --gid 1001 appgroup && \
    adduser  --system --uid 1001 --ingroup appgroup --no-create-home --shell /sbin/nologin appuser

WORKDIR /app
COPY --chown=appuser:appgroup . .
USER appuser
```

```dockerfile
# For distroless images — use numeric UID (no user database available)
FROM gcr.io/distroless/python3-debian12:nonroot
# The :nonroot tag already runs as uid 65532
```

```bash
# Verify the running container user
docker inspect myapp_api_1 --format '{{.Config.User}}'
# Or from inside:
docker exec myapp_api_1 id
```

## Read-Only Root Filesystem

Prevents an attacker from writing malware or backdoors to the container's filesystem after a compromise.

```yaml
services:
  api:
    image: myapp:latest
    read_only: true
    tmpfs:
      - /tmp:size=50m,mode=1777    # writable scratch, limited size
      - /app/cache:size=100m
    volumes:
      - /opt/uploads:/app/uploads  # explicit writable mount for user uploads
```

```bash
# Test that read_only is enforced
docker exec myapp_api_1 touch /test 2>&1
# Expected: touch: /test: Read-only file system
```

## Capability Dropping

Docker grants containers a permissive set of Linux capabilities by default. Drop all, add back only what's needed.

```yaml
services:
  api:
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE   # only if binding to port < 1024 (prefer port > 1024)
    security_opt:
      - no-new-privileges:true    # prevents setuid escalation

  # A service that needs nothing at all (most web apps)
  frontend:
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
```

```bash
# Verify effective capabilities of a running container
docker exec myapp_api_1 cat /proc/1/status | grep Cap
# Decode the hex capset
capsh --decode=0000000000000000   # all zeros = no capabilities
```

## Secrets Hygiene

```dockerfile
# WRONG — secret visible in image history and to anyone with docker inspect
ENV DATABASE_PASSWORD=supersecret
RUN pip install -r requirements.txt

# WRONG — secret baked into layer even if later removed
COPY .env .
RUN source .env && do-something
RUN rm .env   # .env still exists in the previous layer

# RIGHT — use BuildKit secret mounts (never stored in any layer)
# syntax=docker/dockerfile:1
RUN --mount=type=secret,id=pip_token \
    pip install --extra-index-url https://$(cat /run/secrets/pip_token)@pypi.example.com/simple -r requirements.txt
```

```bash
# Pass secret at build time without baking it in
docker build \
  --secret id=pip_token,env=PIP_TOKEN \
  -t myapp:latest .
```

```yaml
# Runtime secrets via compose (tmpfs-backed, not written to disk layers)
services:
  api:
    secrets:
      - db_password
      - jwt_secret
    # Inside container: /run/secrets/db_password (read-only file)

secrets:
  db_password:
    file: ./secrets/db_password.txt   # dev only — gitignored
  jwt_secret:
    external: true                    # prod: managed by Vault, AWS SM, etc.
```

```bash
# Audit image history for exposed secrets
docker history myapp:latest --no-trunc | grep -iE "password|secret|token|key"
# Should return nothing
```

## Image Scanning (CVE Detection)

Integrate scanning into CI — never scan only in post-prod.

```bash
# Trivy (recommended — fast, comprehensive)
trivy image myapp:latest

# Fail CI on CRITICAL CVEs
trivy image --exit-code 1 --severity CRITICAL myapp:latest

# Output as SARIF for GitHub Security tab
trivy image --format sarif --output trivy-results.sarif myapp:latest
```

```yaml
# .github/workflows/scan.yml — scan on every push
- name: Run Trivy vulnerability scanner
  uses: aquasecurity/trivy-action@master
  with:
    image-ref: ${{ env.IMAGE }}
    format: sarif
    output: trivy-results.sarif
    severity: CRITICAL,HIGH
    exit-code: '1'

- name: Upload Trivy results to GitHub Security
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: trivy-results.sarif
```

```bash
# Docker Scout (built into Docker Desktop / Docker Hub)
docker scout cves myapp:latest
docker scout recommendations myapp:latest   # suggests base image upgrades
```

## Minimal Base Images

Every package in the base image is potential attack surface.

| Base | Size | Use when |
|------|------|----------|
| `alpine` | ~7 MB | Small scripts, CLIs — watch for musl libc incompatibilities |
| `*-slim` | 50–100 MB | Most web apps (Python, Node) — systemd-free Debian |
| `distroless` | 20–50 MB | No shell, no package manager — hardest to debug |
| `scratch` | 0 MB | Statically compiled Go/Rust binaries only |
| `*-bookworm` | 100–300 MB | When you need glibc, build tools, or full Debian |

```dockerfile
# Pin exact digest for reproducibility and supply-chain verification
FROM python:3.12-slim@sha256:abc123def456...
# vs.
FROM python:3.12-slim   # could change without warning on next pull
```

```bash
# Get the current digest for pinning
docker pull python:3.12-slim
docker inspect python:3.12-slim --format '{{index .RepoDigests 0}}'
```

## Supply-Chain Verification (Cosign)

Sign images so deployments can verify provenance before running.

```bash
# Install cosign
brew install cosign   # or: go install github.com/sigstore/cosign/v2/cmd/cosign@latest

# Sign after push (uses keyless OIDC in CI, key-based locally)
cosign sign --yes ghcr.io/myorg/myapp:latest@sha256:<digest>

# Verify before pull (in deployment scripts)
cosign verify ghcr.io/myorg/myapp:latest \
  --certificate-identity "https://github.com/myorg/myapp/.github/workflows/build.yml@refs/heads/main" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
```

```yaml
# GitHub Actions — sign after push
- name: Sign the published image
  env:
    DIGEST: ${{ steps.build-push.outputs.digest }}
    TAGS: ${{ steps.meta.outputs.tags }}
  run: |
    echo "${TAGS}" | xargs -I {} cosign sign --yes {}@${DIGEST}
```

## Runtime Policy with seccomp

```json
// seccomp-profile.json — restrict to only needed syscalls
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "architectures": ["SCMP_ARCH_X86_64"],
  "syscalls": [
    {
      "names": ["read", "write", "open", "close", "stat", "fstat",
                "mmap", "mprotect", "munmap", "brk", "rt_sigaction",
                "ioctl", "access", "execve", "exit", "futex",
                "gettimeofday", "socket", "connect", "sendto", "recvfrom",
                "bind", "listen", "accept", "epoll_wait", "epoll_ctl",
                "epoll_create1", "clone", "fork", "wait4", "kill",
                "getcwd", "getpid", "getppid", "uname", "prctl"],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

```yaml
services:
  api:
    security_opt:
      - no-new-privileges:true
      - seccomp:./seccomp-profile.json
```

## Hardening Checklist

- [ ] Non-root user with known UID/GID in every image
- [ ] `read_only: true` + explicit `tmpfs` for writable paths
- [ ] `cap_drop: ALL` + only add back what is verified necessary
- [ ] `no-new-privileges:true` in `security_opt`
- [ ] No secrets in `ENV`, `ARG`, or image layers — use BuildKit mounts or compose secrets
- [ ] Trivy scan in CI — exit 1 on CRITICAL
- [ ] Base image pinned to exact SHA digest
- [ ] `docker history` audit passes — no credential strings in layer commands
- [ ] Named networks with least-privilege topology (DB not reachable from frontend)
- [ ] No ports exposed directly to `0.0.0.0` in production
