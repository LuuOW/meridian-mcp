---
name: multi-agent-collab
description: Running multiple AI coding agents (Claude Code, Codex, OpenClaw) in isolated containers that share a single repo clone via /opt bind mounts, communicate over SSH, and avoid redundant git clones — container topology, volume strategy, inter-agent SSH, and coordination patterns
---

# multi-agent-collab

Architecture for running multiple AI coding agents (Claude Code, Codex CLI, OpenClaw or any OpenAI-compatible gateway) each in their own Docker container, with:
- **One repo clone** shared via `/opt/` bind mount — never cloned N times
- **Inter-agent SSH** for task delegation and status exchange
- **Named volumes** for each agent's private state
- **A coordinator container** that routes tasks and aggregates results

## 1) Mental Model

```
Host /opt/myrepo (single git clone — read/write by coordinator, read-only by workers)
      │
      ├── agent-coordinator (Claude Code) — orchestrates, assigns tasks, merges
      │       ├── SSH → agent-codex
      │       ├── SSH → agent-openclaw
      │       └── bind: /opt/myrepo (read-write)
      │
      ├── agent-codex (OpenAI Codex CLI)
      │       ├── SSH ← coordinator (receives task specs)
      │       └── bind: /opt/myrepo (read-only or scoped subdir)
      │
      └── agent-openclaw (OpenClaw gateway)
              ├── SSH ← coordinator
              └── bind: /opt/myrepo (read-only or scoped subdir)
```

**Key rules:**
1. `git clone` happens **once** on the host at `/opt/myrepo`
2. Containers **bind-mount** that directory — no per-container clones
3. Only the coordinator (or a dedicated `repo-sync` sidecar) does `git pull` / `git push`
4. Workers write to **named volumes** for their private scratch state
5. Agents communicate via SSH, not shared memory or Docker networks directly

## 2) docker-compose Topology

```yaml
# docker-compose.agents.yml
services:

  # ── Coordinator ────────────────────────────────────────────────────────
  agent-coordinator:
    build:
      context: ./agents/coordinator
      dockerfile: Dockerfile
    container_name: agent-coordinator
    restart: unless-stopped
    volumes:
      - /opt/myrepo:/opt/myrepo                  # read-write (does git ops)
      - coordinator-state:/home/agent/.local      # private state
      - /opt/keys:/opt/keys:ro                    # SSH keys to reach workers
    environment:
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}"
      AGENT_CODEX_HOST: agent-codex
      AGENT_OPENCLAW_HOST: agent-openclaw
    networks:
      - agents
    extra_hosts:
      - "host.docker.internal:host-gateway"

  # ── Codex Worker ───────────────────────────────────────────────────────
  agent-codex:
    build:
      context: ./agents/codex
      dockerfile: Dockerfile
    container_name: agent-codex
    restart: unless-stopped
    volumes:
      - /opt/myrepo:/opt/myrepo:ro               # read-only — no direct git push
      - codex-workspace:/workspace               # private scratch volume
      - /opt/keys/codex_authorized_keys:/home/agent/.ssh/authorized_keys:ro
    environment:
      OPENAI_API_KEY: "${OPENAI_API_KEY}"
      REPO_PATH: /opt/myrepo
    networks:
      - agents

  # ── OpenClaw Worker ────────────────────────────────────────────────────
  agent-openclaw:
    build:
      context: ./agents/openclaw
      dockerfile: Dockerfile
    container_name: agent-openclaw
    restart: unless-stopped
    volumes:
      - /opt/myrepo:/opt/myrepo:ro
      - openclaw-workspace:/workspace
      - /opt/keys/openclaw_authorized_keys:/home/agent/.ssh/authorized_keys:ro
    environment:
      OPENAI_API_KEY: "${OPENAI_API_KEY}"
      OPENCLAW_BASE_URL: "${OPENCLAW_BASE_URL}"
    networks:
      - agents

networks:
  agents:
    driver: bridge

volumes:
  coordinator-state:
  codex-workspace:
  openclaw-workspace:
```

## 3) Agent Dockerfile (shared base)

```dockerfile
# agents/base/Dockerfile — used by all agents
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    openssh-server \
    openssh-client \
    git \
    curl \
    python3 python3-pip \
    nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# Create agent user
RUN useradd -m -s /bin/bash agent
RUN mkdir -p /home/agent/.ssh && chmod 700 /home/agent/.ssh

# Configure sshd — listen for incoming connections from coordinator
RUN mkdir /var/run/sshd
RUN sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config
RUN sed -i 's/PermitRootLogin yes/PermitRootLogin no/' /etc/ssh/sshd_config
RUN echo "AllowUsers agent" >> /etc/ssh/sshd_config

# Entrypoint: start sshd + agent process
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
CMD ["/entrypoint.sh"]
```

```bash
# agents/base/entrypoint.sh
#!/bin/bash
set -e
# Start SSH daemon (for incoming coordinator connections)
/usr/sbin/sshd -D &
# Start the agent's own process
exec "$@"
```

## 4) Inter-Agent SSH — Coordinator Reaches Workers

```python
# coordinator/agent_client.py
import subprocess, os

KEYS_DIR = "/opt/keys"

def ssh_agent(agent_name: str, command: str, timeout: int = 120) -> str:
    """
    Run a shell command on a worker agent container via SSH.
    Agent containers are reachable by their Docker service name (DNS).
    """
    key_path = f"{KEYS_DIR}/{agent_name}_key"
    result = subprocess.run(
        [
            "ssh",
            "-i", key_path,
            "-o", "StrictHostKeyChecking=no",
            "-o", "ConnectTimeout=10",
            "-o", "BatchMode=yes",
            f"agent@{agent_name}",   # Docker DNS: service name = hostname
            command,
        ],
        capture_output=True, text=True, timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(f"[{agent_name}] SSH failed: {result.stderr.strip()}")
    return result.stdout.strip()

# Usage:
# ssh_agent("agent-codex", "codex run 'fix the bug in /opt/myrepo/src/utils.py'")
# ssh_agent("agent-openclaw", "openclaw complete --file /opt/myrepo/src/api.py")
```

## 5) Key Management for Inter-Container SSH

```bash
# On the host — generate a key per worker
mkdir -p /opt/keys

# Coordinator → Codex
ssh-keygen -t ed25519 -f /opt/keys/codex_key -N "" -C "coordinator-to-codex"
cp /opt/keys/codex_key.pub /opt/keys/codex_authorized_keys

# Coordinator → OpenClaw
ssh-keygen -t ed25519 -f /opt/keys/openclaw_key -N "" -C "coordinator-to-openclaw"
cp /opt/keys/openclaw_key.pub /opt/keys/openclaw_authorized_keys

# Permissions
chmod 600 /opt/keys/*_key
chmod 644 /opt/keys/*_authorized_keys
```

## 6) Volume Strategy — The /opt Pattern

```
Host filesystem:
/opt/
├── myrepo/                  ← single git clone, bind-mounted into all containers
│   ├── src/
│   ├── tests/
│   └── .git/
├── keys/                    ← SSH keys (bind-mounted read-only into containers)
│   ├── codex_key
│   ├── codex_authorized_keys
│   └── openclaw_key
└── shared-context/          ← JSON task queue / results agents write to
    ├── tasks/
    └── results/

Docker named volumes (container-private):
  coordinator-state     ← Claude Code config, conversation history
  codex-workspace       ← Codex scratch files, temp diffs
  openclaw-workspace    ← OpenClaw workspace
```

**Why `/opt` for the shared repo:**
- System-level directory — not inside any user home, not inside Docker volumes
- Survives container recreation (it's on the host)
- All agents read the same file tree — no sync needed
- Only the coordinator (or repo-sync service) needs write access

**Anti-pattern to avoid:**
```yaml
# WRONG — each agent clones independently
agent-codex:
  command: git clone https://github.com/org/repo /home/agent/repo   # ❌
agent-openclaw:
  command: git clone https://github.com/org/repo /home/agent/repo   # ❌ duplicate
```

```yaml
# RIGHT — single bind mount
agent-codex:
  volumes:
    - /opt/myrepo:/opt/myrepo:ro   # ✓
agent-openclaw:
  volumes:
    - /opt/myrepo:/opt/myrepo:ro   # ✓ same host path, no clone
```

## 7) Task Coordination via Shared Context

```python
# coordinator/task_queue.py
import json, os, uuid
from pathlib import Path
from datetime import datetime

CONTEXT_DIR = Path("/opt/shared-context")

def enqueue_task(agent: str, task: dict) -> str:
    task_id = str(uuid.uuid4())[:8]
    task_file = CONTEXT_DIR / "tasks" / f"{task_id}_{agent}.json"
    task_file.parent.mkdir(parents=True, exist_ok=True)
    task_file.write_text(json.dumps({
        "id": task_id,
        "agent": agent,
        "created_at": datetime.utcnow().isoformat(),
        "status": "pending",
        **task,
    }, indent=2))
    return task_id

def read_result(task_id: str) -> dict | None:
    for f in (CONTEXT_DIR / "results").glob(f"{task_id}_*.json"):
        return json.loads(f.read_text())
    return None

# Worker agents write results:
# Path(f"/opt/shared-context/results/{task_id}_{agent}.json").write_text(...)
```

## 8) Git Workflow in Multi-Agent Context

```python
# coordinator/git_ops.py — coordinator is the only git writer
import subprocess

REPO = "/opt/myrepo"

def git(cmd: list[str]) -> str:
    result = subprocess.run(["git", "-C", REPO] + cmd, capture_output=True, text=True)
    result.check_returncode()
    return result.stdout.strip()

def apply_agent_patch(agent: str, patch_content: str, branch: str):
    """Apply a diff/patch generated by a worker agent."""
    # Create feature branch
    git(["checkout", "-b", branch])

    # Workers produce patches; coordinator applies them
    patch_file = f"/tmp/{agent}.patch"
    with open(patch_file, "w") as f:
        f.write(patch_content)
    subprocess.run(["git", "-C", REPO, "apply", patch_file], check=True)

    git(["add", "-A"])
    git(["commit", "-m", f"feat: {agent} implementation — {branch}"])
    git(["push", "origin", branch])
```

**Worker agents produce patches, coordinator applies and pushes.** Workers never have git credentials.

## 9) Claude Code in Container

```dockerfile
# agents/coordinator/Dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y openssh-client git curl && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

RUN useradd -m -s /bin/bash agent
USER agent
WORKDIR /home/agent

CMD ["claude", "--dangerously-skip-permissions"]
```

```yaml
# Pass through API key + point to shared repo
agent-coordinator:
  environment:
    ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}"
    CLAUDE_CODE_REPO_PATH: /opt/myrepo
  volumes:
    - /opt/myrepo:/opt/myrepo
    - coordinator-state:/home/agent/.claude   # persist Claude Code state
```

## 10) Checklist

- [ ] Repo cloned **once** on host at `/opt/myrepo` — never inside container volumes
- [ ] Worker containers mount `/opt/myrepo:ro` — coordinator mounts read-write
- [ ] Inter-container SSH uses per-agent Ed25519 keys in `/opt/keys/`
- [ ] Worker `authorized_keys` mounted read-only — not baked into image
- [ ] Docker service names used as SSH hostnames (Docker internal DNS)
- [ ] Workers produce patches/diffs — coordinator is the only entity with git credentials
- [ ] Named volumes for agent private state (`coordinator-state`, `codex-workspace`)
- [ ] `/opt/shared-context/` for task queue + results (bind-mounted into all agents)
- [ ] `host.docker.internal` + `host-gateway` for container → host SSH
- [ ] No `git clone` in any `command:` or `entrypoint:` — detect and remove if found
