#!/usr/bin/env python3
"""Deterministic orbit classifier for skills in /opt/skills.

Physics implemented
-------------------
6 orbital classes:
  planet             — broad independent skill; anchors satellites
  moon               — specialist; useful through a parent domain
  trojan             — permanent L4/L5 companion; auto-injected with parent planet
  comet              — high-eccentricity dormant skill; burst-activates near perihelion
  asteroid_belt      — fragmentary utility; no dedicated parent orbit
  irregular_satellite — niche or high-drag; bursty activation, weak anchoring

Mechanics:
  Roche Limit        — skills too close to parent (low independence + high overlap) shred to belt
  Trojan Points      — permanent co-orbiters detected and auto-injected in routing
  Orbital Resonance  — co-activated pairs boost each other's route score
  Tidal Locking      — near-zero independent activation → merger candidate warning
  Hill Sphere        — planet moon-capacity limit; excess moons migrate to next-best parent
  Dynamic Eccentricity — activation variance updates each simulation step
  Binary Systems     — tightly coupled planet pairs boost each other in routing
  Escape Velocity    — topology-aware promotion: heavier parent needs more momentum to escape
  Accretion Execution — belt fragment consolidation generates concrete merge recommendations
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import math
from collections import defaultdict
import re
from pathlib import Path
from typing import Iterable


ROOT = Path("/opt/skills")

# ── Universe naming / body types ─────────────────────────────────────────────
# The engine is domain-agnostic: it scores a graph of entities, classifies them
# into archetypes by mass / independence / eccentricity, and detects companions.
# ASTRO_NAMING is the astronomical skin — the only place where the vocabulary
# "planet / moon / trojan / comet / asteroid_belt" appears as user-facing labels.
# To introduce a second universe (e.g. biochem: protein / ligand / ion / peptide
# / fragment) you would:
#   1. Add BIOCHEM_NAMING below with the same keys.
#   2. Switch the `NAMING` binding based on a --universe CLI flag or env var.
#   3. Provide a matching corpus with the same frontmatter shape.
# The physics (thresholds, Roche/trojan detection, scoring) remains unchanged.
ASTRO_NAMING = {
    "broad_independent":  "planet",              # high scope + high independence
    "specialist":         "moon",                # useful through a parent planet
    "companion":          "trojan",              # permanent L4/L5 co-orbital
    "dormant_burst":      "comet",               # high-eccentricity, activates near perihelion
    "fragmented":         "asteroid_belt",       # Roche-disrupted, collective behaviour
    "displaced":          "irregular_satellite", # captured, low activation
    "parent_term":        "parent",
    "companion_term":     "trojan_of",
    "stability_region":   "habitable_zone",
    "merger_flag":        "tidal_lock",
    "disruption_flag":    "roche_disrupted",
}
NAMING = ASTRO_NAMING  # future: select at runtime per universe

# ── Classification thresholds ─────────────────────────────────────────────────
PLANET_THRESHOLD        = 0.50
IRREGULAR_THRESHOLD     = 0.38
ASTEROID_BELT_THRESHOLD = 0.49

# ── Roche Limit ───────────────────────────────────────────────────────────────
# Skills inside the Roche limit (too close to parent) shred into asteroid belt.
ROCHE_INDEPENDENCE_LIMIT = 0.35   # independence floor
ROCHE_OVERLAP_THRESHOLD  = 0.55   # overlap_risk ceiling trigger

# ── Trojan Points (L4/L5) ─────────────────────────────────────────────────────
# Moons below these thresholds are permanent companions, not independent moons.
TROJAN_MAX_INDEPENDENCE  = 0.55   # independence ceiling for trojan classification
TROJAN_MIN_DEPENDENCY    = 0.65   # high fraction of weight comes via parent's profiles

# ── Tidal Locking ─────────────────────────────────────────────────────────────
# Skills showing near-zero rotation relative to parent → merger candidates.
TIDAL_LOCK_INDEPENDENCE  = 0.38
TIDAL_LOCK_DEPENDENCY    = 0.85

# ── Comet class ───────────────────────────────────────────────────────────────
# Highly eccentric orbits: dormant except during strong task-context matches.
COMET_ECCENTRICITY       = 0.45   # minimum eccentricity
COMET_MAX_ACTIVATION     = 0.42   # maximum activation_frequency
COMET_MIN_MASS           = 0.45   # must have substance to be a comet (not just noise)

# ── Hill Sphere ───────────────────────────────────────────────────────────────
# hill_radius = HILL_SPHERE_COEFFICIENT * planet_mass^(1/3)
HILL_SPHERE_COEFFICIENT  = 0.40

# ── Binary Systems ────────────────────────────────────────────────────────────
# Two planets are a binary if they are similar in mass and co-activate strongly.
BINARY_MAX_MASS_RATIO    = 1.60
BINARY_MIN_CO_WEIGHT     = 0.50

# ── Resonance ─────────────────────────────────────────────────────────────────
# Pairs of skills with both weights ≥ this in a profile are resonant.
RESONANCE_MIN_WEIGHT     = 0.65

# ── Conjunction ───────────────────────────────────────────────────────────────
# Two skills are in conjunction when their phase seeds differ by ≤ this window.
CONJUNCTION_WINDOW       = 0.12

# ── Orbital period (Kepler's 3rd law) ─────────────────────────────────────────
# T = PERIOD_SCALE * a^(3/2).  Controls how fast phase advances per sim step.
PERIOD_SCALE             = 3.00

# ── Stellar wind ─────────────────────────────────────────────────────────────
# Eccentricity drift added per simulation step per unit stellar_wind.
# Mind (X-class, wind=0.90) pushes skills toward burstier activation than
# Forge (B-class, wind=0.70) or Signal (G-class, wind=0.50).
STELLAR_WIND_ECC_RATE    = 0.004


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


# ── Term vocabularies ─────────────────────────────────────────────────────────

BROAD_TERMS = {
    "architecture",
    "audience",
    "design system",
    "devops",
    "environment",
    "evidence",
    "framework-agnostic",
    "frontend",
    "github",
    "grounded",
    "matrix",
    "patterns",
    "persona",
    "production",
    "public profile",
    "research",
    "social",
    "synthesis",
    "transcript",
    "workflow",
    "youtube",
}

TOKEN_ECONOMY_TERMS = {
    "budget",
    "cache",
    "compact",
    "compaction",
    "compression",
    "context window",
    "cost",
    "efficiency",
    "energy",
    "grep",
    "latency",
    "minimum-effective",
    "scoped read",
    "throughput",
    "token",
    "tokens",
    "waste",
}

SPECIALIST_TERMS = {
    "animation",
    "badge",
    "card",
    "ci/cd",
    "component",
    "css",
    "framer motion",
    "layout",
    "motion",
    "padding",
    "spacing",
    "table",
    "tailwind",
    "test",
}

FRAGMENT_TERMS = {
    "badge",
    "button",
    "card",
    "container",
    "gesture",
    "layout",
    "micro",
    "padding",
    "skeleton",
    "spacing",
    "statcard",
    "table",
    "utility",
    "variant",
}

CROSS_DOMAIN_TERMS = {
    "across",
    "coordination",
    "cross",
    "evidence-backed",
    "framework-agnostic",
    "general-purpose",
    "multi-agent",
    "public footprint",
    "signal",
    "social profiles",
    "routing",
    "shared",
    "source base",
    "topology",
    "transcript-backed",
}

INFRA_TERMS = {
    "deploy",
    "deployment",
    "docker",
    "github actions",
    "monitoring",
    "nginx",
    "reverse proxy",
    "ssl",
    "systemd",
    "vps",
}

DOCS_TERMS = {
    "architecture.md",
    "changelog",
    "codebase",
    "docs",
    "documentation",
    "md-first",
    "readme",
}

LOW_FREQ_TERMS = {
    "ci/cd",
    "deploy",
    "deployment",
    "handoff",
    "release",
    "rollback",
}

HIGH_FREQ_TERMS = {
    "api",
    "component",
    "css",
    "frontend",
    "layout",
    "persona",
    "podcast",
    "react",
    "transcript",
    "ui",
    "youtube",
}

PARENT_CANDIDATES = [
    "api",
    "content",
    "database",
    "devops",
    "docker",
    "docs-update",
    "github",
    "knowledge",
    "llm-integration",
    "network",
    "nextjs-dashboard",
    "reasoning",
    "token-awareness",
    "ux-ui-expert",
]

# Skills whose content naturally mentions parent-planet terms as examples
# (not as domain signals), causing mis-attribution. Override takes precedence
# over scored selection.
FORCED_PARENT: dict[str, str] = {
    "docs-update":          "github",        # git-workflow skill; cites docker only as example
    "multi-agent-collab":   "devops",        # orchestration; cites docker infrastructure by example
    "background-tasks":     "api",           # task queues are an API-layer concern, not Docker
    "caching":              "api",           # cache-aside lives at the API/service layer
    "auth":                 "api",           # JWT/security dependency lives at the API layer
    "observability":        "devops",        # logging/metrics/health is infra/ops concern
    "llm-integration":      "api",           # LLM calls are API-layer async services
    "event-driven":         "api",           # event bus sits at service layer (Redis/streams)
    "vector-store":         "database",      # Qdrant is a specialised database
    "multi-llm-routing":    "llm-integration",  # routing layer on top of LLM clients
    "schema-authority":     "api",              # schema contracts live at the API layer
    "state-management":     "ux-ui-expert",     # frontend state is a UI concern
    "persona-research":     "content",          # public footprint and authored-source curation
    "transcript-ingestion": "knowledge",        # spoken-source capture feeds retrieval/synthesis
    "partner-skill-compiler": "llm-integration",  # grounded synthesis becomes agent behavior
}

ANCHOR_SKILL_SLUGS = {
    "api",
    "database",
    "devops",
    "docker",
    "docs-update",
    "event-driven",
    "github",
    "network",
    "token-awareness",
    "ux-ui-expert",
}

TASK_PROFILES: dict[str, dict] = {
    "frontend": {
        "keywords": {"ui", "frontend", "css", "react", "component", "layout", "dashboard", "tailwind", "motion"},
        "skill_weights": {
            "ux-ui-expert":       1.0,
            "tailwind-css":       0.9,
            "shadcn-ui":          0.85,
            "css-spacing-layout": 0.8,
            "framer-motion":      0.7,
            "react-dashboard-cards": 0.8,
            "nextjs-dashboard":   0.85,
            "astro-expert":       0.75,
            "state-management":   0.85,
        },
    },
    "backend": {
        "keywords": {"api", "fastapi", "http", "jwt", "pydantic", "backend", "service"},
        "skill_weights": {
            "api":              1.0,
            "unit-test":        0.75,
            "env-management":   0.70,
            "database":         0.80,
            "caching":          0.65,
            "auth":             0.75,
            "background-tasks": 0.60,
            "observability":    0.55,
            "llm-integration":  0.50,
            "schema-authority": 0.75,
        },
    },
    "release": {
        "keywords": {"deploy", "release", "production", "rollback", "pipeline", "github actions", "ci/cd"},
        "skill_weights": {
            "devops": 1.0,
            "ci-cd": 0.95,
            "github": 0.9,
            "docker": 0.85,
            "docker-registry": 0.80,
            "env-management": 0.6,
        },
    },
    "networking": {
        "keywords": {"network", "firewall", "vpn", "wireguard", "tcp", "udp", "routing", "iptables", "nftables", "ufw", "ssh", "port", "bandwidth", "latency", "dns", "tls", "ssl", "ip"},
        "skill_weights": {
            "network": 1.0,
            "firewall": 0.90,
            "wireguard": 0.85,
            "dns": 0.80,
            "ssl-tls": 0.80,
            "port-scanner": 0.70,
            "ssh-hardening": 0.65,
            "rate-limiting": 0.60,
            "ip-blocklist": 0.60,
        },
    },
    "security": {
        "keywords": {"hardening", "harden", "block", "blocklist", "allowlist", "ban", "rate limit", "brute force", "fail2ban", "ssh key", "authorized_keys", "sshd", "attack", "intrusion"},
        "skill_weights": {
            "ssh-hardening":     1.0,
            "rate-limiting":     0.95,
            "ip-blocklist":      0.95,
            "firewall":          0.90,
            "container-security": 0.85,
            "network":           0.70,
            "auth":              0.80,
        },
    },
    "container": {
        "keywords": {"docker", "container", "dockerfile", "compose", "image", "registry", "buildkit", "containerize"},
        "skill_weights": {
            "docker": 1.0,
            "docker-compose": 0.90,
            "container-security": 0.85,
            "docker-registry": 0.80,
            "devops": 0.50,
        },
    },
    "docs": {
        "keywords": {"docs", "readme", "architecture", "changelog", "handoff", "documentation", "style guide", "versioning", "adr", "runbook", "post-mortem", "template"},
        "skill_weights": {
            "docs-update": 1.0,
            "docs-strategy": 0.90,
            "doc-templates": 0.80,
            "token-awareness": 0.75,
            "token-economics": 0.70,
            "github": 0.45,
        },
    },
    "api-docs": {
        "keywords": {"openapi", "swagger", "asyncapi", "spec", "endpoint", "reference", "sdk", "redoc", "operationid", "schema"},
        "skill_weights": {
            "api-reference":    1.0,
            "api":              0.85,
            "schema-authority": 0.90,
            "docs-strategy":    0.55,
            "github":           0.40,
        },
    },
    "coordination": {
        "keywords": {"multi-agent", "coordination", "orchestrate", "workflow", "routing", "delegate"},
        "skill_weights": {
            "multi-agent-collab": 1.0,
            "docs-update": 0.5,
            "github": 0.35,
            "devops": 0.45,
        },
    },
    "testing": {
        "keywords": {
            "test", "tests", "testing", "unit test", "unit tests", "integration test",
            "pytest", "vitest", "jest", "regression", "stabilization",
            "contract", "pact", "schemathesis", "async", "fixture",
            "mock", "coverage",
        },
        "skill_weights": {
            "unit-test":        1.0,
            "tests":            0.95,
            "schema-authority": 0.55,
            "api":              0.40,
            "github":           0.30,
        },
    },
    "ai": {
        "keywords": {"llm", "openai", "anthropic", "claude", "gpt", "prompt", "embedding", "vector", "agent", "context window", "token", "model"},
        "skill_weights": {
            "llm-integration":    1.0,
            "multi-llm-routing":  0.90,
            "api":                0.80,
            "caching":            0.60,
            "token-awareness":    0.75,
            "token-economics":    0.85,
            "context-compaction": 0.80,
            "multi-agent-collab": 0.70,
            "background-tasks":   0.55,
            "vector-store":       0.65,
        },
    },
    "token-economy": {
        "keywords": {"token", "tokens", "context window", "compression", "compaction", "cache", "budget", "energy", "watt", "latency", "throughput", "cost"},
        "skill_weights": {
            "token-awareness":    1.0,
            "token-economics":    0.95,
            "context-compaction": 0.90,
            "llm-integration":    0.55,
            "multi-llm-routing":  0.50,
            "reasoning":          0.40,
        },
    },
    "data": {
        "keywords": {"database", "sql", "postgres", "supabase", "migration", "schema", "orm", "query", "index", "transaction", "asyncpg"},
        "skill_weights": {
            "database":         1.0,
            "vector-store":     0.70,
            "api":              0.60,
            "env-management":   0.50,
            "caching":          0.65,
            "observability":    0.45,
            "schema-authority": 0.70,
        },
    },
    "events": {
        "keywords": {"event", "pub/sub", "pubsub", "stream", "redis stream", "channel", "subscribe", "publish", "consumer", "message bus", "dead-letter", "dlq"},
        "skill_weights": {
            "event-driven":     1.0,
            "caching":          0.70,
            "background-tasks": 0.65,
            "api":              0.55,
            "observability":    0.50,
        },
    },
    "rag": {
        "keywords": {"rag", "retrieval", "vector search", "embedding", "qdrant", "semantic search", "knowledge base", "chunking", "upsert"},
        "skill_weights": {
            "vector-store":    1.0,
            "knowledge":       0.85,
            "llm-integration": 0.80,
            "database":        0.60,
            "caching":         0.50,
        },
    },
    "async-tasks": {
        "keywords": {"celery", "worker", "queue", "scheduler", "background", "beat", "job", "task queue", "brpop", "lpush"},
        "skill_weights": {
            "background-tasks": 1.0,
            "caching":          0.70,
            "docker-compose":   0.65,
            "observability":    0.60,
            "api":              0.50,
        },
    },
    "monitoring": {
        "keywords": {
            "log", "logs", "logging", "metric", "metrics", "health", "health check",
            "alert", "alerts", "monitor", "monitors", "monitoring", "trace", "tracing",
            "observability", "structured", "pm2", "uptime",
            "error tracking", "errors", "exception", "sentry", "prometheus",
            "grafana", "dashboard panel", "production service",
            "watch", "watches", "watching", "detect", "detects", "detection",
            "anomaly", "anomalies", "threshold", "circuit breaker",
            "risk", "risks", "depeg", "drift",
        },
        "skill_weights": {
            "observability":  1.0,
            "analytics":      0.70,
            "devops":         0.55,
            "background-tasks": 0.50,
            "docker":         0.40,
            "docker-compose": 0.35,
        },
    },
    "auth": {
        "keywords": {
            "auth", "jwt", "token", "login", "session", "oauth", "rbac", "role",
            "permission", "supabase auth", "api key", "passkey", "passkeys",
            "webauthn", "2fa", "mfa", "totp",
            "secret", "secrets", "environment variable", "environment variables",
            "env var", "env vars", ".env", "dotenv", "credential", "credentials",
            "leak", "leaking",
        },
        "skill_weights": {
            "auth":           1.0,
            "env-management": 0.90,
            "api":            0.60,
            "ssl-tls":        0.45,
        },
    },
    "persona": {
        "keywords": {
            "persona", "profile", "public profile", "public footprint", "founder",
            "website", "article", "bio", "about", "linkedin", "newsletter",
            "youtube", "podcast", "interview",
            "transcript", "captions", "show notes", "voice", "worldview",
            "operating style", "partner prompt", "self-authored", "biography",
            "social media", "social profile", "evidence-backed",
        },
        "skill_weights": {
            "persona-research":      1.0,
            "transcript-ingestion":  0.95,
            "partner-skill-compiler": 1.0,
            "content":               0.80,
            "knowledge":             0.85,
            "llm-integration":       0.70,
            "reasoning":             0.60,
            "analytics":             0.35,
        },
    },
    "defi": {
        "keywords": {
            "defi", "flashloan", "flash loan", "arbitrage", "arb", "uniswap", "aave",
            "amm", "liquidity", "dex", "swap", "stablecoin", "stablecoins", "depeg",
            "solidity", "smart contract", "erc20", "erc721", "evm",
            "foundry", "hardhat", "mev", "aerodrome", "curve", "balancer",
            "base chain", "arbitrum", "optimism", "polygon",
            "on-chain", "onchain", "price feed", "oracle", "liquidation",
            "collateral", "vault", "yield", "apr", "apy", "tvl", "protocol",
            "wld", "world coin", "worldcoin",
        },
        "skill_weights": {
            "defi-protocols":   1.0,
            "solidity":         0.95,
            "observability":    0.60,
            "api":              0.50,
            "env-management":   0.40,
            "background-tasks": 0.45,
        },
    },
    "mobile": {
        "keywords": {
            "react native", "react-native", "mobile", "mobile app", "ios app",
            "android app", "expo", "app store", "play store", "testflight",
            "push notification", "deep link", "eas build", "native module",
            "objective-c", "swift", "kotlin",
        },
        "skill_weights": {
            "react-native":    1.0,
            "ux-ui-expert":    0.55,
            "state-management":0.50,
            "framer-motion":   0.30,
        },
    },
    "kubernetes": {
        "keywords": {
            "kubernetes", "k8s", "kubectl", "helm", "kustomize", "pod",
            "deployment", "statefulset", "daemonset", "configmap",
            "ingress", "cluster", "namespace", "eks", "gke", "aks",
            "node pool", "rollout", "operator", "crd", "service mesh",
        },
        "skill_weights": {
            "kubernetes":       1.0,
            "docker":           0.70,
            "docker-compose":   0.50,
            "devops":           0.80,
            "container-security":0.55,
            "observability":    0.45,
        },
    },
    "ml-training": {
        "keywords": {
            "train", "training", "classifier", "regressor", "dataset",
            "fine-tune", "fine tune", "hyperparameter", "pytorch", "tensorflow",
            "scikit-learn", "sklearn", "xgboost", "optuna", "transformer",
            "huggingface", "epoch", "gradient descent", "cross-validation",
            "feature engineering", "overfit", "loss function",
        },
        "skill_weights": {
            "ml-training":            1.0,
            "uncertainty-quantification":0.70,
            "reasoning":              0.45,
            "physics-units-si":       0.30,
            "llm-integration":        0.35,
        },
    },
    "science": {
        "keywords": {
            "arxiv", "paper", "papers", "preprint", "scientific", "abstract",
            "citation", "citations", "journal", "peer review", "peer-reviewed",
            "physics", "neutron", "cosmology", "quantum", "equation",
            "latex", "formula", "typeset", "mathematical notation",
            "semantic scholar", "arxiv-taxonomy", "research paper",
            "literature review", "methodology",
        },
        "skill_weights": {
            "arxiv-taxonomy":           1.0,
            "scientific-writing-voice": 0.95,
            "semantic-scholar-api":     0.90,
            "physics-units-si":         0.75,
            "latex":                    0.85,
            "exa-search":               0.55,
            "doc-templates":            0.45,
            "uncertainty-quantification":0.50,
        },
    },
    "scraping": {
        "keywords": {
            "scrape", "scraping", "scraper", "crawl", "crawler", "anti-bot",
            "stealth", "anonymize", "anonymous", "proxy", "residential proxy",
            "brightdata", "firecrawl", "apify", "headless browser",
            "cloudflare bypass", "captcha", "bot detection", "user agent",
        },
        "skill_weights": {
            "brightdata-collection": 1.0,
            "browser-stealth":       0.95,
            "firecrawl-extract":     0.95,
            "web-intelligence":      0.80,
            "exa-search":            0.45,
            "content":               0.40,
        },
    },
    "seo": {
        "keywords": {
            "seo", "search engine", "search engine optimization",
            "meta tag", "meta tags", "sitemap", "canonical", "structured data",
            "schema.org", "keyword", "keywords", "organic traffic", "serp",
            "ranking", "backlink", "landing page", "page speed", "lcp", "inp",
        },
        "skill_weights": {
            "seo":     1.0,
            "content": 0.70,
            "web-intelligence": 0.40,
            "analytics":        0.45,
        },
    },
    "agents": {
        "keywords": {
            "agent", "agents", "autonomous", "autonomous agent", "agentic",
            "agent loop", "planner", "executor", "plan and execute",
            "tool use", "tool-calling", "multi-agent", "crew", "swarm",
            "reasoning loop", "self-correction",
            "monitor", "monitors", "monitoring agent", "watchdog",
            "autopilot", "automate", "automated", "automation",
            "pipeline", "workflow", "orchestrate", "orchestration",
        },
        "skill_weights": {
            "agent-loop":         1.0,
            "multi-agent-collab": 0.90,
            "orchestration":      0.85,
            "reasoning":          0.75,
            "llm-integration":    0.60,
            "observability":      0.55,
            "background-tasks":   0.50,
            "context-compaction": 0.45,
        },
    },
}


# ── Resonance pairs (computed once at module load) ────────────────────────────

def _build_resonance_pairs() -> dict[tuple[str, str], float]:
    """
    Orbital resonance: skill pairs that co-activate strongly across task profiles.
    When skill A routes, resonant partner B gets a route_score boost.
    Strength = average min(weight_A, weight_B) across profiles where both appear
    at or above RESONANCE_MIN_WEIGHT.
    """
    pair_total: dict[tuple[str, str], float] = {}
    pair_count: dict[tuple[str, str], int] = {}
    for profile in TASK_PROFILES.values():
        weights = profile["skill_weights"]
        high = [s for s, w in weights.items() if w >= RESONANCE_MIN_WEIGHT]
        for i, a in enumerate(high):
            for b in high[i + 1:]:
                key = (min(a, b), max(a, b))
                pair_total[key] = pair_total.get(key, 0.0) + min(weights[a], weights[b])
                pair_count[key] = pair_count.get(key, 0) + 1
    return {k: clamp(v / pair_count[k]) for k, v in pair_total.items()}


RESONANCE_PAIRS: dict[tuple[str, str], float] = _build_resonance_pairs()


# ── Galaxy Configuration ──────────────────────────────────────────────────────
# Meridian Galaxy — three star systems, each a gravitational centre of value.
# Forge  (B-class, blue-white)   : Engineering & Infrastructure
# Signal (G-class, yellow-amber) : Growth, Marketing & Distribution
# Mind   (X-class, magnetar)     : AI, Intelligence, Reasoning & token/energy economics

GALAXY_NAME = "Meridian"

@dataclasses.dataclass
class StarSystem:
    slug:            str
    name:            str
    spectral_class:  str    # B / G / X(magnetar)
    temperature:     float  # domain evolution rate 0-1
    luminosity:      float  # output/activity level 0-1
    stellar_wind:    float  # coupling tightness to planets 0-1
    habitable_zone:  tuple  # (min_scope, max_scope) for stable planets
    color:           str

STAR_SYSTEMS: dict[str, StarSystem] = {
    "forge": StarSystem(
        slug="forge", name="Forge",
        spectral_class="B",
        temperature=0.80, luminosity=0.85, stellar_wind=0.70,
        habitable_zone=(0.40, 1.00),
        color="blue-white",
    ),
    "signal": StarSystem(
        slug="signal", name="Signal",
        spectral_class="G",
        temperature=0.50, luminosity=0.65, stellar_wind=0.50,
        habitable_zone=(0.35, 0.85),
        color="yellow-amber",
    ),
    "mind": StarSystem(
        slug="mind", name="Mind",
        spectral_class="X",
        temperature=0.95, luminosity=0.90, stellar_wind=0.90,
        habitable_zone=(0.40, 1.00),
        color="violet-white",
    ),
}

# Primary system assignment for every skill
SKILL_SYSTEM_MAP: dict[str, str] = {
    # ── Forge (Engineering) ────────────────────────────────────────────────────
    "api":               "forge",
    "api-reference":     "forge",
    "astro-expert":      "forge",
    "auth":              "forge",
    "background-tasks":  "forge",
    "caching":           "forge",
    "ci-cd":             "forge",
    "container-security":"forge",
    "css-spacing-layout":"forge",
    "curl-recipes":      "forge",
    "database":          "forge",
    "devops":            "forge",
    "dns":               "forge",
    "doc-templates":     "forge",
    "docker":            "forge",
    "docker-compose":    "forge",
    "docker-registry":   "forge",
    "docs-strategy":     "forge",
    "docs-update":       "forge",
    "env-management":    "forge",
    "firewall":          "forge",
    "framer-motion":     "forge",
    "github":            "forge",
    "ip-blocklist":      "forge",
    "multi-agent-collab":"forge",
    "network":           "forge",
    "nextjs-dashboard":  "forge",
    "observability":     "forge",
    "port-scanner":      "forge",
    "rate-limiting":     "forge",
    "react-dashboard-cards": "forge",
    "shadcn-ui":         "forge",
    "ssh-hardening":     "forge",
    "ssl-tls":           "forge",
    "tailwind-css":      "forge",
    "token-awareness":   "mind",
    "unit-test":         "forge",
    "ux-ui-expert":      "forge",
    "webhook":           "forge",
    "wireguard":         "forge",
    "schema-authority":  "forge",
    "state-management":  "forge",
    "firecrawl-extract": "forge",
    "brightdata-collection": "forge",
    # ── Signal (Growth / Marketing) ───────────────────────────────────────────
    "seo":               "signal",
    "content":           "signal",
    "outbound":          "signal",
    "analytics":         "signal",
    "persona-research":  "signal",
    # ── Mind (AI / Intelligence) ──────────────────────────────────────────────
    "web-intelligence":  "mind",
    "exa-search":        "mind",
    "partner-skill-compiler": "mind",
    "reasoning":         "mind",
    "orchestration":     "mind",
    "knowledge":         "mind",
    "token-economics":   "mind",
    "context-compaction":"mind",
    "event-driven":      "mind",   # reactive architecture; also bridges to Forge
    "transcript-ingestion": "mind",
    "vector-store":      "forge",  # Qdrant ops; also bridges to Mind
    "multi-llm-routing": "forge",  # provider routing; also bridges to Mind
    # ── Lagrange bridges (primary system above; secondary in LAGRANGE_BRIDGES) ─
    "llm-integration":   "forge",  # also bridges to Mind
}

# Cross-system gravity bridges — skills with stable pull from multiple stars
LAGRANGE_BRIDGES: dict[str, list[str]] = {
    "llm-integration":    ["forge", "mind"],
    "multi-agent-collab": ["forge", "mind"],
    "orchestration":      ["mind",  "forge"],
    "observability":      ["forge", "signal"],
    "database":           ["forge", "signal"],
    "auth":               ["forge", "signal", "mind"],
    "caching":            ["forge", "mind"],
    "analytics":          ["signal","forge"],
    "persona-research":   ["signal", "mind"],
    "knowledge":          ["mind",  "signal"],
    "partner-skill-compiler": ["mind", "signal"],
    "reasoning":          ["mind",  "forge"],
    "transcript-ingestion": ["mind", "signal"],
    "token-awareness":    ["forge", "mind"],
    "token-economics":    ["mind",  "forge"],
    "context-compaction": ["mind",  "forge"],
    "event-driven":       ["mind",  "forge"],
    "vector-store":       ["forge", "mind"],
    "multi-llm-routing":  ["forge", "mind"],
    "schema-authority":   ["forge", "mind"],    # schema truth matters in LLM context design too
    "web-intelligence":   ["mind", "forge", "signal"],
    "exa-search":         ["mind", "signal"],
    "firecrawl-extract":  ["forge", "mind"],
    "brightdata-collection": ["forge", "signal"],
}


# ── Dataclasses ───────────────────────────────────────────────────────────────

@dataclasses.dataclass
class Skill:
    slug: str
    name: str
    description: str
    body: str
    path: Path

    @property
    def text(self) -> str:
        return f"{self.name}\n{self.description}\n{self.body}".lower()


@dataclasses.dataclass
class SkillState:
    slug: str
    orbit_class: str
    parent: str | None
    latent_parent: str | None
    phase: float
    velocity: float
    mass: float
    drag: float
    fragmentation: float
    scope: float
    independence: float
    overlap_risk: float
    trust: float
    staleness: float
    health: float
    eccentricity: float      # dynamic: updated each simulation step
    planet_score: float
    belt_score: float
    irregular_score: float
    energy_load: float
    energy_efficiency: float
    # ── Optical properties (static: derived from skill content) ───────────────
    albedo:          float   # α reflectance: context re-emitted outward
    transmittance:   float   # τ context pass-through to satellites
    luminance:       float   # L actionable signal density
    scattering:      float   # σ breadth of task-profile activation
    # ── Galactic properties ───────────────────────────────────────────────────
    star_system:     str     # primary star system (forge | signal | mind)
    lagrange_potential: float  # stability score if skill bridges multiple systems
    semi_major_axis: float    # a: orbital radius proxy — smaller = closer to star
    orbital_period:  float    # T: Kepler period T = PERIOD_SCALE * a^(3/2)


@dataclasses.dataclass
class TaskContext:
    raw_text: str
    profiles: dict[str, float]

    def weight_for(self, slug: str) -> float:
        weight = 0.0
        for profile_name, profile_weight in self.profiles.items():
            profile = TASK_PROFILES[profile_name]
            weight += profile_weight * profile["skill_weights"].get(slug, 0.0)
        return clamp(weight)


# ── Helpers ───────────────────────────────────────────────────────────────────

def unique_terms_present(text: str, terms: Iterable[str]) -> int:
    hits = 0
    for term in terms:
        pattern = r"(?<!\w)" + re.escape(term).replace(r"\ ", r"\s+") + r"(?!\w)"
        if re.search(pattern, text):
            hits += 1
    return hits


def normalize_hits(hits: int, scale: int) -> float:
    return clamp(hits / scale if scale else 0.0)


def build_task_context(task_text: str | None) -> TaskContext:
    text = (task_text or "").lower()
    if not text.strip():
        return TaskContext(raw_text="", profiles={})
    profiles: dict[str, float] = {}
    for profile_name, profile in TASK_PROFILES.items():
        hits = unique_terms_present(text, profile["keywords"])
        if hits:
            profiles[profile_name] = clamp(hits / 3)
    return TaskContext(raw_text=text, profiles=profiles)


def load_skill(skill_dir: Path) -> Skill:
    skill_md = skill_dir / "SKILL.md"
    raw = skill_md.read_text(encoding="utf-8")
    frontmatter_match = re.match(r"^---\n(.*?)\n---\n(.*)$", raw, re.S)
    frontmatter: dict[str, str] = {}
    body = raw
    if frontmatter_match:
        meta_block, body = frontmatter_match.groups()
        for line in meta_block.splitlines():
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            frontmatter[key.strip()] = value.strip()
    return Skill(
        slug=skill_dir.name,
        name=frontmatter.get("name", skill_dir.name),
        description=frontmatter.get("description", ""),
        body=body,
        path=skill_md,
    )


def _common_prefix(words: list[str]) -> str:
    """Common hyphen-segment prefix: ['css-spacing', 'css-layout'] → 'css'."""
    if not words:
        return ""
    parts = [w.split("-") for w in words]
    prefix = []
    for segments in zip(*parts):
        if len(set(segments)) == 1:
            prefix.append(segments[0])
        else:
            break
    return "-".join(prefix)


# ── Scoring functions ─────────────────────────────────────────────────────────

def score_scope(skill: Skill) -> float:
    text = skill.text
    broad_hits = unique_terms_present(text, BROAD_TERMS)
    specialist_hits = unique_terms_present(text, SPECIALIST_TERMS)
    heading_count = len(re.findall(r"^## ", skill.body, re.M))
    code_block_count = len(re.findall(r"^```", skill.body, re.M)) // 2
    raw = 0.36
    raw += 0.16 * normalize_hits(broad_hits, 5)
    raw += 0.05 * clamp(heading_count / 8)
    raw += 0.04 * clamp(code_block_count / 5)
    raw -= 0.06 * normalize_hits(specialist_hits, 5)
    if "framework-agnostic" in text or "general-purpose" in text:
        raw += 0.10
    if skill.slug in ANCHOR_SKILL_SLUGS:
        raw += 0.12
    if any(term in text for term in ("core rule", "mental model", "orientation protocol", "production patterns")):
        raw += 0.05
    return clamp(raw)


def score_independence(skill: Skill) -> float:
    text = skill.text
    raw = 0.45
    if "synthesized from" in text or "extracted from" in text:
        raw -= 0.08
    if "production" in text:
        raw += 0.08
    if "pattern" in text or "patterns" in text:
        raw += 0.06
    if "specific" in text:
        raw -= 0.04
    if "framework-agnostic" in text or "general-purpose" in text:
        raw += 0.12
    infra_hits = unique_terms_present(text, INFRA_TERMS)
    docs_hits = unique_terms_present(text, DOCS_TERMS)
    raw += 0.05 * normalize_hits(infra_hits + docs_hits, 4)
    if skill.slug in ANCHOR_SKILL_SLUGS:
        raw += 0.10
    if any(term in text for term in ("applies across", "used across", "for solo and team projects")):
        raw += 0.05
    return clamp(raw)


def score_cross_domain(skill: Skill) -> float:
    text = skill.text
    hits = unique_terms_present(text, CROSS_DOMAIN_TERMS)
    raw = 0.15 + 0.15 * normalize_hits(hits, 4)
    if any(term in text for term in ("python", "typescript", "react", "fastapi")):
        raw += 0.12
    if "and" in skill.description.lower():
        raw += 0.05
    if skill.slug in {"docs-update", "token-awareness"}:
        raw += 0.08
    return clamp(raw)


def score_overlap_risk(skill: Skill) -> float:
    text = skill.text
    hits = unique_terms_present(text, SPECIALIST_TERMS)
    raw = 0.20 + 0.18 * normalize_hits(hits, 5)
    if "expert" in text:
        raw += 0.08
    if "framework-agnostic" in text or "general-purpose" in text:
        raw -= 0.10
    if "docker" in text or "github actions" in text:
        raw -= 0.04
    if skill.slug in ANCHOR_SKILL_SLUGS:
        raw -= 0.10
    return clamp(raw)


def score_fragmentation(skill: Skill) -> float:
    text = skill.text
    fragment_hits = unique_terms_present(text, FRAGMENT_TERMS)
    raw = 0.18 + 0.24 * normalize_hits(fragment_hits, 5)
    if any(term in text for term in ("expert in", "specialty", "specialist", "patterns extracted")):
        raw += 0.10
    if any(term in text for term in ("framework-agnostic", "general-purpose", "mental model")):
        raw -= 0.08
    if skill.slug in ANCHOR_SKILL_SLUGS:
        raw -= 0.12
    return clamp(raw)


def score_activation_frequency(skill: Skill) -> float:
    text = skill.text
    high = unique_terms_present(text, HIGH_FREQ_TERMS)
    low = unique_terms_present(text, LOW_FREQ_TERMS)
    raw = 0.45
    raw += 0.18 * normalize_hits(high, 4)
    raw -= 0.18 * normalize_hits(low, 4)
    if "always" in text or "every" in text:
        raw += 0.05
    if skill.slug in {"api", "ux-ui-expert", "devops", "docker", "network"}:
        raw += 0.08
    return clamp(raw)


def score_drag(skill: Skill) -> float:
    text = skill.text
    raw = 0.20
    if any(term in text for term in ("ssh", "docker", "systemd", "secrets", "deploy")):
        raw += 0.20
    if any(term in text for term in ("multi-agent", "topology", "coordination")):
        raw += 0.20
    if any(term in text for term in ("docs", "documentation", "readme")):
        raw += 0.08
    if any(term in text for term in ("css", "card", "spacing", "motion")):
        raw -= 0.05
    if skill.slug in {"api", "ux-ui-expert"}:
        raw -= 0.05
    if skill.slug == "docs-update":
        raw -= 0.10
    return clamp(raw)


def score_energy_load(
    skill: Skill,
    scope: float,
    cross_domain: float,
    fragmentation: float,
    drag: float,
) -> float:
    """Estimated token-energy demand for activating and using a skill."""
    text = skill.text
    token_hits = unique_terms_present(text, TOKEN_ECONOMY_TERMS)
    raw = (
        0.18
        + 0.22 * drag
        + 0.18 * scope
        + 0.10 * cross_domain
        + 0.08 * fragmentation
        - 0.12 * normalize_hits(token_hits, 6)
    )
    if skill.slug in {"multi-agent-collab", "orchestration"}:
        raw += 0.12
    if skill.slug in {"token-awareness", "token-economics", "context-compaction"}:
        raw -= 0.18
    return clamp(raw)


def score_energy_efficiency(
    skill: Skill,
    drag: float,
    luminance: float,
    energy_load: float,
) -> float:
    """Actionable signal produced per token-energy unit."""
    text = skill.text
    token_hits = unique_terms_present(text, TOKEN_ECONOMY_TERMS)
    raw = (
        0.20
        + 0.38 * luminance
        + 0.18 * (1.0 - drag)
        + 0.18 * (1.0 - energy_load)
        + 0.08 * normalize_hits(token_hits, 6)
    )
    if skill.slug in {"token-awareness", "token-economics", "context-compaction"}:
        raw += 0.12
    return clamp(raw)


def compute_semi_major_axis(scope: float, drag: float, activation_frequency: float) -> float:
    """Semi-major axis proxy (AU-analogue).

    Broad, fast, low-drag skills orbit close to the star (small a).
    Distant, slow, high-drag skills have large semi-major axes and longer periods.
    Range: [0.30, 1.80] AU-analogues.
    """
    raw = 0.50 + 0.40 * drag + 0.30 * (1.0 - scope) + 0.20 * (1.0 - activation_frequency)
    return clamp(raw, 0.30, 1.80)


def compute_orbital_period(semi_major_axis: float) -> float:
    """Kepler's third law: T² ∝ a³  →  T = PERIOD_SCALE * a^(3/2).

    Planets near the star (small a) complete more activation cycles per task
    batch.  Distant comets and irregular satellites update phase slowly,
    making them harder to catch near perihelion.
    """
    return round(PERIOD_SCALE * (semi_major_axis ** 1.5), 4)


# ── Optical properties ────────────────────────────────────────────────────────
# These four properties model how skills interact with light (context/signal flow).
# Inspired by geometric optics: reflection, transmission, emission, and scattering.

DELEGATION_PHRASES = (
    "pairs with", "pairs well", "together with", "alongside",
    "delegates", "see also", "use with", "combine with",
    "works with", "complements", "use alongside",
)

PASS_THROUGH_PHRASES = (
    "builds on", "extends", "based on", "on top of",
    "passes", "provides context", "downstream", "chains into",
)


def score_albedo(skill: Skill) -> float:
    """Reflectance (α): fraction of incoming context re-emitted outward.
    High albedo = relay hub / bright delegator.
    Low albedo  = terminal absorber (self-contained, end of the routing chain)."""
    text = skill.text
    raw = 0.18
    delegation_hits = sum(1 for phrase in DELEGATION_PHRASES if phrase in text)
    raw += 0.07 * min(delegation_hits, 4)
    if skill.slug in ANCHOR_SKILL_SLUGS:
        raw += 0.22   # planets are the brightest relay hubs
    raw += 0.05 * normalize_hits(unique_terms_present(text, CROSS_DOMAIN_TERMS), 4)
    if any(t in text for t in ("standalone", "self-contained", "complete reference", "comprehensive guide")):
        raw -= 0.10
    checklist_count = len(re.findall(r"^- \[", skill.body, re.M))
    raw -= 0.02 * clamp(checklist_count / 10)   # heavy checklists = terminal absorption
    return clamp(raw)


def score_transmittance(skill: Skill) -> float:
    """Transmittance (τ): context pass-through to satellite skills.
    High = parent transmits rich context to its moons (transparent).
    Low  = opaque skill — consumes context, nothing escapes to children."""
    text = skill.text
    # Proxy scope/independence locally to avoid circular deps
    scope       = score_scope(skill)
    independence = score_independence(skill)
    drag        = score_drag(skill)
    raw = 0.35
    raw += 0.14 * scope
    raw += 0.10 * independence
    pass_hits = sum(1 for phrase in PASS_THROUGH_PHRASES if phrase in text)
    raw += 0.06 * min(pass_hits, 3)
    if skill.slug in ANCHOR_SKILL_SLUGS:
        raw += 0.14   # anchor planets actively pass context to moons
    raw -= 0.20 * drag   # high drag = context gets lost in activation friction
    if any(t in text for t in ("standalone", "utility", "helper", "micro")):
        raw -= 0.08
    return clamp(raw)


def score_luminance(skill: Skill) -> float:
    """Luminance (L): actionable signal density per unit of content.
    High = dense code blocks, checklists, decision criteria (emits strong signal).
    Low  = mostly narrative/theoretical (dim, low concrete emission)."""
    body = skill.body
    code_blocks     = len(re.findall(r"^```", body, re.M)) // 2
    headings        = len(re.findall(r"^## ", body, re.M))
    checklist_items = len(re.findall(r"^- \[", body, re.M))
    word_count      = max(1, len(body.split()))
    # Signal density: concrete elements per 100 words
    signal_density = (code_blocks * 2.0 + headings * 0.8 + checklist_items * 1.5) / (word_count / 100.0)
    raw = clamp(0.18 + 0.52 * clamp(signal_density / 3.5))
    if code_blocks >= 4 and checklist_items >= 5:
        raw += 0.10   # bimodal signal: both executable examples AND action checklists
    if code_blocks == 0:
        raw -= 0.12   # no code = near-zero executable signal
    return clamp(raw)


def score_scattering(skill: Skill) -> float:
    """Scattering coefficient (σ): breadth of task-profile activation.
    High = activates broadly across many different task contexts (wide scatter).
    Low  = focused single-profile activation (narrow beam)."""
    profile_hits = sum(
        1 for profile in TASK_PROFILES.values()
        if skill.slug in profile["skill_weights"]
    )
    total_profiles = len(TASK_PROFILES)
    raw = profile_hits / max(total_profiles, 1)
    if profile_hits == 0:
        # Not yet in any profile — estimate from cross-domain signals
        cross_hits = unique_terms_present(skill.text, CROSS_DOMAIN_TERMS)
        raw = 0.04 + 0.08 * normalize_hits(cross_hits, 4)
    raw += 0.04 * normalize_hits(unique_terms_present(skill.text, CROSS_DOMAIN_TERMS), 4)
    return clamp(raw)


# ── Galactic scoring ──────────────────────────────────────────────────────────

# Term vocabularies per star system (used for stellar affinity scoring)
_SYSTEM_TERMS: dict[str, set[str]] = {
    "forge": {
        "api", "docker", "deploy", "network", "infra", "backend", "devops",
        "container", "nginx", "ssl", "firewall", "ssh", "ci/cd", "build",
        "server", "database", "redis", "cache", "auth", "test", "lint",
    },
    "signal": {
        "seo", "serp", "keyword", "content", "email", "outbound", "lead",
        "marketing", "campaign", "analytics", "conversion", "funnel", "utm",
        "audience", "brand", "editorial", "publish", "traffic", "rank",
        "backlink", "cohort", "attribution", "crm", "sequence", "growth",
        "linkedin", "newsletter", "social", "youtube", "podcast", "profile",
        "persona", "public footprint", "reputation",
    },
    "mind": {
        "llm", "prompt", "reasoning", "agent", "embedding", "vector",
        "rag", "chain-of-thought", "evaluation", "orchestration", "memory",
        "knowledge", "claude", "openai", "gpt", "anthropic", "inference",
        "context window", "fine-tune", "judge", "self-consistency", "tool use",
        "persona", "transcript", "captions", "worldview", "operating style",
        "evidence-backed", "voice", "partner prompt", "synthesis",
    },
}


def score_stellar_affinity(skill: Skill, system_slug: str) -> float:
    """How strongly does this skill's content align with a given star system?
    Returns 0-1. Used to confirm system assignment and compute lagrange_potential."""
    terms = _SYSTEM_TERMS.get(system_slug, set())
    if not terms:
        return 0.0
    hits = unique_terms_present(skill.text, terms)
    raw = normalize_hits(hits, min(len(terms) // 3, 8))
    # Boost if explicitly assigned to this system
    if SKILL_SYSTEM_MAP.get(skill.slug) == system_slug:
        raw += 0.20
    return clamp(raw)


def compute_lagrange_potential(skill: Skill) -> float:
    """Stability score for cross-system position (0 = single-system, 1 = perfectly balanced bridge).
    High lagrange_potential = skill is meaningfully useful in 2+ star systems."""
    bridge_systems = LAGRANGE_BRIDGES.get(skill.slug, [])
    if len(bridge_systems) < 2:
        return 0.0
    affinities = [score_stellar_affinity(skill, s) for s in bridge_systems]
    # A good Lagrange bridge has strong affinity in both systems, not just one
    min_affinity = min(affinities)
    avg_affinity = sum(affinities) / len(affinities)
    return clamp(min_affinity * 0.60 + avg_affinity * 0.40)


# ── Parent selection ──────────────────────────────────────────────────────────

def pick_parent_scores(skill: Skill, all_skills: list[Skill]) -> dict[str, float]:
    """Return affinity scores for every parent candidate (no winner selected).

    Token match score is length-normalised so large SKILL.md files don't
    dominate purely by volume.  Semantic keyword boosts are applied after
    normalisation and act as the primary differentiator.
    """
    text = skill.text
    scores: dict[str, float] = {}
    for candidate in PARENT_CANDIDATES:
        if candidate == skill.slug:
            continue
        candidate_text = next((s.text for s in all_skills if s.slug == candidate), candidate)
        # Raw token overlap
        candidate_tokens = {
            t for t in re.findall(r"[a-z0-9][a-z0-9/+.-]+", candidate_text)
            if len(t) >= 4
        }
        raw_match = sum(1.0 for t in candidate_tokens if t in text)
        # Normalise: scale to "as if candidate had 50 unique tokens" baseline
        length_factor = max(1.0, (len(candidate_tokens) / 50) ** 0.5)
        score = raw_match / length_factor

        # Semantic keyword boosts — these are the primary signal
        if candidate == "ux-ui-expert" and any(t in text for t in ("react", "ui", "css", "tailwind", "dashboard", "astro")):
            score += 8.0
        if candidate == "api" and any(t in text for t in ("fastapi", "http", "jwt", "pydantic", "test")):
            score += 8.0
        if candidate == "devops" and any(t in text for t in ("deploy", "nginx", "systemd", "vps", "monitoring")):
            score += 8.0
        if candidate == "docker" and any(t in text for t in ("docker", "container", "compose", "dockerfile", "image", "registry", "buildkit")):
            score += 8.0
        if candidate == "network" and any(t in text for t in ("tcp", "udp", "firewall", "routing", "wireguard", "vpn", "dns", "ssl", "tls", "iptables", "nftables", "ufw", "ssh", "port", "network")):
            score += 8.0
        if candidate == "github" and any(t in text for t in ("git", "github", "pull request", "actions")):
            score += 6.0
        if candidate == "docs-update" and any(t in text for t in ("docs", "documentation", "readme", "changelog", "architecture")):
            score += 6.0
        if candidate == "nextjs-dashboard" and any(t in text for t in ("next.js", "dashboard")):
            score += 6.0
        if candidate == "content" and any(t in text for t in ("audience", "newsletter", "social", "content", "profile", "persona", "public", "youtube", "podcast", "linkedin")):
            score += 8.0
        if candidate == "knowledge" and any(t in text for t in ("retrieval", "rag", "knowledge", "evidence", "source", "transcript", "captions", "show notes", "grounded")):
            score += 8.0
        if candidate == "llm-integration" and any(t in text for t in ("prompt", "agent", "partner prompt", "simulation", "synthesis", "voice model", "persona profile")):
            score += 8.0
        if candidate == "reasoning" and any(t in text for t in ("worldview", "operating style", "tradeoff", "mental model", "decision", "belief")):
            score += 6.0
        scores[candidate] = score
    return scores


def pick_parent(skill: Skill, all_skills: list[Skill]) -> str | None:
    if skill.slug in FORCED_PARENT:
        return FORCED_PARENT[skill.slug]
    scores = pick_parent_scores(skill, all_skills)
    if not scores:
        return None
    best = max(scores.items(), key=lambda x: x[1])
    return best[0] if best[1] > 0 else None


# ── Parent dependency ratio (for Trojan/Tidal-lock detection) ─────────────────

def parent_dependency_ratio(slug: str, parent_slug: str | None) -> float:
    """
    Fraction of this skill's total task-profile weight that flows through
    profiles which also activate its parent.  High ratio → Trojan / tidal lock.
    """
    if not parent_slug:
        return 0.0
    total = 0.0
    via_parent = 0.0
    for profile in TASK_PROFILES.values():
        sw = profile["skill_weights"].get(slug, 0.0)
        pw = profile["skill_weights"].get(parent_slug, 0.0)
        total += sw
        if pw > 0.0:
            via_parent += sw
    return (via_parent / total) if total > 0.01 else 0.0


# ── Classification ────────────────────────────────────────────────────────────

def classify(skill: Skill, all_skills: list[Skill]) -> dict[str, object]:
    scope             = score_scope(skill)
    independence      = score_independence(skill)
    cross_domain      = score_cross_domain(skill)
    overlap_risk      = score_overlap_risk(skill)
    fragmentation     = score_fragmentation(skill)
    activation_frequency = score_activation_frequency(skill)
    drag              = score_drag(skill)
    # Optical properties
    albedo        = score_albedo(skill)
    transmittance = score_transmittance(skill)
    luminance     = score_luminance(skill)
    scattering    = score_scattering(skill)
    # Energetics
    energy_load        = score_energy_load(skill, scope, cross_domain, fragmentation, drag)
    energy_efficiency  = score_energy_efficiency(skill, drag, luminance, energy_load)
    # Galactic properties
    star_system       = SKILL_SYSTEM_MAP.get(skill.slug, "forge")
    lagrange_potential = compute_lagrange_potential(skill)
    lagrange_systems  = LAGRANGE_BRIDGES.get(skill.slug, [])
    latent_parent     = pick_parent(skill, all_skills)
    parent            = latent_parent

    planet_score = (
        0.32 * scope
        + 0.28 * independence
        + 0.18 * cross_domain
        + 0.14 * activation_frequency
        - 0.10 * overlap_risk
        - 0.08 * drag
        + 0.04 * energy_efficiency
        - 0.03 * energy_load
    )
    irregular_score = (
        0.28 * drag
        + 0.24 * overlap_risk
        + 0.20 * (1 - activation_frequency)
        + 0.16 * cross_domain
        + 0.12 * (1 - independence)
    )
    asteroid_belt_score = (
        0.32 * fragmentation
        + 0.26 * overlap_risk
        + 0.20 * (1 - independence)
        + 0.12 * (1 - scope)
        + 0.10 * activation_frequency
    )

    mass = clamp(
        0.30 * scope
        + 0.25 * independence
        + 0.15 * activation_frequency
        + 0.15 * (1 - overlap_risk)
        + 0.15 * (1 - drag)
    )
    eccentricity    = clamp(0.55 * (1 - activation_frequency) + 0.25 * cross_domain + 0.20 * drag)
    inclination     = clamp(0.65 * cross_domain + 0.20 * drag + 0.15 * (1 - overlap_risk))
    semi_major_axis = compute_semi_major_axis(scope, drag, activation_frequency)
    orbital_period  = compute_orbital_period(semi_major_axis)
    phase_seed      = round((sum(ord(c) for c in skill.slug) % 100) / 100.0, 3)

    # ── Initial classification ────────────────────────────────────────────────
    if planet_score >= PLANET_THRESHOLD and scope >= 0.50 and independence >= 0.55:
        orbit_class = "planet"
        parent = None
    elif (
        asteroid_belt_score >= ASTEROID_BELT_THRESHOLD
        and fragmentation >= 0.42
        and scope <= 0.46
        and independence <= 0.53
        and overlap_risk >= 0.36
    ):
        orbit_class = "asteroid_belt"
        parent = None
    elif irregular_score >= 0.56 and drag >= 0.35 and activation_frequency <= 0.45:
        orbit_class = "irregular_satellite"
    elif planet_score <= IRREGULAR_THRESHOLD and drag >= 0.45:
        orbit_class = "irregular_satellite"
    else:
        orbit_class = "moon"

    # ── Roche Limit (post-classification) ────────────────────────────────────
    # A skill inside the Roche limit lacks the self-gravity to hold together as
    # an independent orbit; tidal forces from the parent shred it to belt.
    roche_disrupted = False
    if orbit_class not in ("planet", "asteroid_belt") and parent:
        if independence < ROCHE_INDEPENDENCE_LIMIT and overlap_risk > ROCHE_OVERLAP_THRESHOLD:
            orbit_class = "asteroid_belt"
            parent = None
            roche_disrupted = True

    # ── Comet detection ───────────────────────────────────────────────────────
    # High eccentricity + low baseline activation + enough mass = comet.
    # Comets burst near perihelion (strong task match) and are dormant otherwise.
    if orbit_class in ("moon", "irregular_satellite"):
        if (
            eccentricity > COMET_ECCENTRICITY
            and activation_frequency < COMET_MAX_ACTIVATION
            and mass > COMET_MIN_MASS
        ):
            orbit_class = "comet"

    # ── Trojan / Tidal-lock detection ─────────────────────────────────────────
    # Trojans live at L4/L5 — permanently co-orbiting, no independent orbit.
    # Tidal lock (weaker form) flags merger candidates without reclassifying.
    dep_ratio  = parent_dependency_ratio(skill.slug, latent_parent)
    tidal_lock = False

    if orbit_class == "moon":
        if independence < TROJAN_MAX_INDEPENDENCE and dep_ratio >= TROJAN_MIN_DEPENDENCY:
            orbit_class = "trojan"
            tidal_lock  = True
        elif independence < TIDAL_LOCK_INDEPENDENCE and dep_ratio >= TIDAL_LOCK_DEPENDENCY:
            tidal_lock = True

    # ── Habitable zone check ──────────────────────────────────────────────────
    # Planets whose scope falls outside their star system's habitable zone are
    # structurally unstable — too close (too specialist) or too far (too broad).
    system_obj = STAR_SYSTEMS.get(SKILL_SYSTEM_MAP.get(skill.slug, "forge"), STAR_SYSTEMS["forge"])
    hz_lo, hz_hi = system_obj.habitable_zone
    habitable_zone_stable = bool(hz_lo <= scope <= hz_hi) if orbit_class == "planet" else True

    return {
        "slug":                  skill.slug,
        "display_name":          skill.name,
        "class":                 orbit_class,
        "parent":                parent,
        "latent_parent":         latent_parent,
        "roche_disrupted":       roche_disrupted,
        "tidal_lock":            tidal_lock,
        "habitable_zone_stable": habitable_zone_stable,
        "scores": {
            "planet_score":        round(planet_score, 3),
            "irregular_score":     round(irregular_score, 3),
            "asteroid_belt_score": round(asteroid_belt_score, 3),
            "scope":               round(scope, 3),
            "independence":        round(independence, 3),
            "cross_domain":        round(cross_domain, 3),
            "activation_frequency": round(activation_frequency, 3),
            "overlap_risk":        round(overlap_risk, 3),
            "fragmentation":       round(fragmentation, 3),
            "drag":                round(drag, 3),
            "mass":                round(mass, 3),
            "eccentricity":        round(eccentricity, 3),
            "inclination":         round(inclination, 3),
            "energy_load":         round(energy_load, 3),
            "energy_efficiency":   round(energy_efficiency, 3),
            "dep_ratio":           round(dep_ratio, 3),
            # Orbital mechanics (new)
            "semi_major_axis":     round(semi_major_axis, 3),
            "orbital_period":      round(orbital_period, 3),
            "phase_seed":          phase_seed,
            # Optical properties
            "albedo":              round(albedo, 3),
            "transmittance":       round(transmittance, 3),
            "luminance":           round(luminance, 3),
            "scattering":          round(scattering, 3),
        },
        "decision_rule":    decision_rule_text(orbit_class),
        # Galactic fields (top-level, not inside scores)
        "star_system":      star_system,
        "lagrange_systems": lagrange_systems,
        "lagrange_potential": round(lagrange_potential, 3),
    }


def decision_rule_text(orbit_class: str) -> str:
    rules = {
        "planet":            "Broad independent skill with enough scope and pull to anchor satellites.",
        "trojan":            "Trojan companion at L4/L5 — permanently co-orbits its parent planet, auto-injected when parent activates.",
        "comet":             "High-eccentricity dormant skill — quiescent until a strong task match triggers perihelion burst activation.",
        "asteroid_belt":     "Fragmentary utility skill that belongs to a shared belt instead of a dedicated parent orbit.",
        "irregular_satellite": "Niche or high-drag skill with bursty activation and weak stable anchoring.",
    }
    return rules.get(orbit_class, "Specialist skill that is useful, but usually through a broader parent domain.")


# ── Hill Sphere correction (post-classify pass) ───────────────────────────────

def apply_hill_sphere_correction(
    results: list[dict[str, object]], all_skills: list[Skill]
) -> None:
    """
    Each planet can hold moons within its gravitational sphere of influence.
    Hill sphere radius = HILL_SPHERE_COEFFICIENT * planet_mass^(1/3).
    Moons with the lowest affinity to their planet migrate to the next-best parent.

    Mutates results in-place.
    """
    planet_masses = {
        r["slug"]: float(r["scores"]["mass"])  # type: ignore[index]
        for r in results
        if r["class"] == "planet"
    }

    # Group satellites by parent
    satellites_by_parent: dict[str, list[dict]] = defaultdict(list)
    for r in results:
        if r["class"] in ("moon", "trojan", "comet", "irregular_satellite") and r.get("parent"):
            satellites_by_parent[str(r["parent"])].append(r)

    for planet_slug, planet_mass in planet_masses.items():
        satellites = satellites_by_parent.get(planet_slug, [])
        # Maximum stable moons = 3 + floor(planet_mass * 6)
        max_satellites = max(3, int(3 + planet_mass * 6))

        if len(satellites) <= max_satellites:
            continue  # within Hill sphere capacity

        # Compute each satellite's affinity (closeness) to this planet
        affinities: list[tuple[float, dict]] = []
        for sat in satellites:
            skill = next((s for s in all_skills if s.slug == sat["slug"]), None)
            if skill is None:
                affinities.append((0.0, sat))
                continue
            pscores = pick_parent_scores(skill, all_skills)
            max_score = max(pscores.values(), default=0.01)
            planet_score = pscores.get(planet_slug, 0.0)
            affinity = planet_score / max(max_score, 0.01)
            affinities.append((affinity, sat))

        # Sort ascending — lowest affinity = furthest from planet = escape first
        # Protect skills with a forced parent assignment from migration.
        affinities.sort(key=lambda x: x[0])
        excess = len(satellites) - max_satellites

        for affinity, sat in affinities[:excess]:
            # Never migrate a skill that has been explicitly forced to this planet
            if FORCED_PARENT.get(str(sat["slug"])) == planet_slug:
                continue
            skill = next((s for s in all_skills if s.slug == sat["slug"]), None)
            if skill is None:
                continue
            pscores = pick_parent_scores(skill, all_skills)
            # Find next-best parent that isn't the current one
            new_parent = next(
                (cand for cand, _ in sorted(pscores.items(), key=lambda x: x[1], reverse=True)
                 if cand != planet_slug),
                None,
            )
            if new_parent:
                hill_radius = HILL_SPHERE_COEFFICIENT * (planet_mass ** (1.0 / 3.0))
                sat["parent"] = new_parent
                sat["hill_sphere_escaped"] = True
                sat["hill_sphere_detail"] = (
                    f"affinity={affinity:.2f} < hill_radius={hill_radius:.2f} "
                    f"(planet={planet_slug} mass={planet_mass:.3f}); "
                    f"migrated to {new_parent}"
                )


# ── Binary system detection ───────────────────────────────────────────────────

def detect_binary_systems(results: list[dict[str, object]]) -> set[frozenset]:
    """
    Two planets form a binary system when their mass ratio is close and they
    co-activate strongly across task profiles.  Selecting either member in
    routing boosts the other's route_score.
    """
    planets = {r["slug"]: r for r in results if r["class"] == "planet"}
    planet_slugs = list(planets.keys())
    binary_pairs: set[frozenset] = set()

    for i, a in enumerate(planet_slugs):
        for b in planet_slugs[i + 1:]:
            mass_a = float(planets[a]["scores"]["mass"])   # type: ignore[index]
            mass_b = float(planets[b]["scores"]["mass"])   # type: ignore[index]
            mass_ratio = max(mass_a, mass_b) / max(min(mass_a, mass_b), 0.001)
            if mass_ratio > BINARY_MAX_MASS_RATIO:
                continue
            # Co-weight: average min(w_a, w_b) across profiles where both appear
            co_total = 0.0
            co_count = 0
            for profile in TASK_PROFILES.values():
                wa = profile["skill_weights"].get(str(a), 0.0)
                wb = profile["skill_weights"].get(str(b), 0.0)
                if wa > 0 and wb > 0:
                    co_total += min(wa, wb)
                    co_count += 1
            if co_count > 0 and (co_total / co_count) >= BINARY_MIN_CO_WEIGHT:
                binary_pairs.add(frozenset([a, b]))

    return binary_pairs


# ── State initialisation ──────────────────────────────────────────────────────

def state_from_result(result: dict[str, object]) -> SkillState:
    scores = result["scores"]
    assert isinstance(scores, dict)
    orbit_class = str(result["class"])
    mass = float(scores["mass"])
    drag = float(scores["drag"])
    staleness = clamp(
        0.18
        + 0.18 * float(scores["fragmentation"])
        + 0.12 * float(scores["overlap_risk"])
        + 0.08 * drag
        - 0.12 * float(scores["activation_frequency"])
    )
    trust   = clamp(0.40 + 0.35 * mass + 0.15 * float(scores["independence"]) - 0.10 * drag)
    health  = clamp(0.50 + 0.35 * trust + 0.20 * mass - 0.25 * staleness - 0.15 * drag)
    phase_seed      = float(scores.get("phase_seed",
                           (sum(ord(c) for c in str(result["slug"])) % 100) / 100))
    semi_major_axis = float(scores.get("semi_major_axis", 0.80))
    orbital_period  = float(scores.get("orbital_period",  2.00))
    return SkillState(
        slug=str(result["slug"]),
        orbit_class=orbit_class,
        parent=result["parent"] and str(result["parent"]),
        latent_parent=result.get("latent_parent") and str(result["latent_parent"]),
        phase=phase_seed,
        velocity=float(scores["activation_frequency"]),
        mass=mass,
        drag=drag,
        fragmentation=float(scores["fragmentation"]),
        scope=float(scores["scope"]),
        independence=float(scores["independence"]),
        overlap_risk=float(scores["overlap_risk"]),
        trust=trust,
        staleness=staleness,
        health=health,
        eccentricity=float(scores["eccentricity"]),
        planet_score=float(scores["planet_score"]),
        belt_score=float(scores["asteroid_belt_score"]),
        irregular_score=float(scores["irregular_score"]),
        energy_load=float(scores.get("energy_load", 0.40)),
        energy_efficiency=float(scores.get("energy_efficiency", 0.55)),
        albedo=float(scores.get("albedo", 0.25)),
        transmittance=float(scores.get("transmittance", 0.45)),
        luminance=float(scores.get("luminance", 0.40)),
        scattering=float(scores.get("scattering", 0.10)),
        star_system=str(result.get("star_system", "forge")),
        lagrange_potential=float(result.get("lagrange_potential", 0.0)),
        semi_major_axis=semi_major_axis,
        orbital_period=orbital_period,
    )


# ── Routing ───────────────────────────────────────────────────────────────────

def route_task(
    results: list[dict[str, object]],
    task_text: str,
    limit: int = 5,
    binary_pairs: set[frozenset] | None = None,
    systems: list[str] | None = None,
) -> dict[str, object]:
    """
    Score and rank skills for a task.  Applies:
      - Comet perihelion boost (near-perfect task match overrides dormancy)
      - Eccentricity perihelion boost (high-variance skills peak near match)
      - systems filter: restrict routing to one or more star systems
      - Resonance boost (selected skill A boosts resonant partner B)
      - Binary boost (selecting one binary planet boosts its partner)
      - Trojan auto-injection (trojans ride in for free when parent is selected)
    """
    task_context = build_task_context(task_text)
    if binary_pairs is None:
        binary_pairs = set()

    results_by_slug: dict[str, dict] = {str(r["slug"]): r for r in results}

    # Apply star-system filter — include skill if it's in a target system OR is a Lagrange bridge to one
    if systems:
        system_set = set(systems)
        results = [
            r for r in results
            if str(r.get("star_system", "forge")) in system_set
            or any(s in system_set for s in r.get("lagrange_systems", []))
        ]

    routed: list[dict[str, object]] = []
    for result in results:
        scores = result["scores"]
        assert isinstance(scores, dict)
        slug        = str(result["slug"])
        orbit_class = str(result["class"])
        task_weight = task_context.weight_for(slug)
        eccentricity = float(scores.get("eccentricity", 0.30))

        luminance    = float(scores.get("luminance",    0.40))
        scattering   = float(scores.get("scattering",   0.10))
        phase_seed   = float(scores.get("phase_seed",   0.50))
        inclination  = float(scores.get("inclination",  0.15))
        alignment = clamp(
            0.55 * task_weight                 # was 0.45 — task relevance weighted more
            + 0.16 * float(scores["mass"])     # was 0.20
            + 0.12 * float(scores["scope"])    # was 0.15
            + 0.10 * float(scores["independence"])
            - 0.12 * float(scores["drag"])
            - 0.08 * float(scores["overlap_risk"])
            - 0.05 * float(scores.get("energy_load", 0.40))
            + 0.06 * float(scores.get("energy_efficiency", 0.55))
            + 0.04 * luminance       # high signal density → routing preference
            + 0.02 * scattering      # wide-scatter skills get marginal cross-context boost
        )

        # Orbital class base modifiers — reduced so specialists compete on merit
        if orbit_class == "planet":
            alignment += 0.05         # was 0.08
        elif orbit_class == "moon":
            alignment += 0.04
        elif orbit_class == "trojan":
            alignment += 0.02  # small base; usually free-injected
        elif orbit_class == "comet":
            # Perihelion burst: strong task match overrides dormancy
            if task_weight >= 0.60:
                alignment += 0.14
            else:
                alignment -= 0.02  # near apoapsis — dormant
        elif orbit_class == "asteroid_belt":
            alignment -= 0.03
        elif orbit_class == "irregular_satellite":
            alignment -= 0.06

        # Eccentricity perihelion scaling (applies to all high-ecc skills)
        if eccentricity > 0.55 and task_weight > 0.60:
            perihelion_boost = 0.08 * ((eccentricity - 0.55) / 0.45) * ((task_weight - 0.60) / 0.40)
            alignment += perihelion_boost

        # ── Kepler's 2nd law: apoapsis suppression ────────────────────────────
        # A body moves slowest near apoapsis (phase_seed ≈ 0.0 or 1.0).
        # High-eccentricity skills are hard to reach from that position —
        # they require more delta-v to intercept than near perihelion (≈ 0.5).
        phase_dist = abs(phase_seed - 0.5)   # 0 = perihelion, 0.5 = apoapsis
        if eccentricity > 0.45 and phase_dist > 0.35:
            apoapsis_penalty = 0.07 * eccentricity * ((phase_dist - 0.35) / 0.15)
            alignment -= apoapsis_penalty

        # ── Inclination routing cost ──────────────────────────────────────────
        # Cross-domain (high-inclination) skills pay a routing cost proportional
        # to how much the task is NOT cross-domain.  When many profiles are active
        # the task is itself cross-domain and the penalty nearly vanishes.
        cross_domain_task = clamp(len(task_context.profiles) / 5.0)
        alignment -= 0.05 * inclination * (1.0 - 0.70 * cross_domain_task)

        routed.append({
            "slug":         slug,
            "class":        orbit_class,
            "parent":       result.get("parent"),
            "latent_parent": result.get("latent_parent"),
            "task_weight":  round(task_weight, 3),
            "route_score":  round(clamp(alignment), 3),
            "why":          route_reason(slug, orbit_class, task_weight,
                                         result.get("parent") or result.get("latent_parent")),
            "tidal_lock":   bool(result.get("tidal_lock", False)),
        })

    routed.sort(key=lambda item: (item["route_score"], item["task_weight"]), reverse=True)
    selected       = routed[:limit]
    selected_slugs = {str(s["slug"]) for s in selected}

    # ── Slingshot / gravitational assist ─────────────────────────────────────
    # High-albedo, high-transmittance relay skills act as gravitational assists:
    # when selected, they reduce effective drag for ALL non-selected skills,
    # with the boost scaling by drag (helping high-friction skills most).
    # Physics: the translator skill reflects coherent context signal outward,
    # lowering the delta-v needed to reach the next destination.
    TRANSLATOR_SLUGS = {"docs-update", "token-awareness", "env-management"}
    slingshot_power  = 0.0
    for item in selected:
        s  = str(item["slug"])
        if s not in TRANSLATOR_SLUGS:
            continue
        sr = results_by_slug.get(s, {})
        sc = sr.get("scores", {})
        if not isinstance(sc, dict):
            continue
        slingshot_power = max(
            slingshot_power,
            0.08 * float(sc.get("albedo", 0.25)) * float(sc.get("transmittance", 0.45)),
        )
    slingshot_boosts: dict[str, float] = {}
    if slingshot_power > 0.0:
        for r in results:
            target = str(r["slug"])
            if target in selected_slugs:
                continue
            sc   = r.get("scores", {})
            drag_v = float(sc.get("drag", 0.30)) if isinstance(sc, dict) else 0.30
            slingshot_boosts[target] = round(slingshot_power * drag_v, 4)

    # ── Orbital resonance boosts ──────────────────────────────────────────────
    # Selected skill A boosts resonant partner B in the remaining pool.
    resonance_boosts: dict[str, float] = {}
    for item in selected:
        a = str(item["slug"])
        for (ra, rb), strength in RESONANCE_PAIRS.items():
            partner = rb if ra == a else (ra if rb == a else None)
            if partner and partner not in selected_slugs:
                resonance_boosts[partner] = max(resonance_boosts.get(partner, 0.0), 0.10 * strength)

    # ── Binary system boosts ──────────────────────────────────────────────────
    for item in selected:
        a = str(item["slug"])
        for pair in binary_pairs:
            if a in pair:
                partner = next((p for p in pair if p != a), None)
                if partner and partner not in selected_slugs:
                    resonance_boosts[partner] = max(resonance_boosts.get(partner, 0.0), 0.12)

    # Merge slingshot boosts into the resonance pool before re-scoring
    for target, boost in slingshot_boosts.items():
        resonance_boosts[target] = max(resonance_boosts.get(target, 0.0), boost)

    # Re-score remaining pool with boosts, re-sort, extend selection if warranted
    if resonance_boosts:
        remaining = [r for r in routed if str(r["slug"]) not in selected_slugs]
        for item in remaining:
            slug = str(item["slug"])
            if slug in resonance_boosts:
                item = dict(item)
                item["route_score"] = round(clamp(float(item["route_score"]) + resonance_boosts[slug]), 3)
                item["resonance_boost"] = round(resonance_boosts[slug], 3)
        remaining.sort(key=lambda x: (x["route_score"], x["task_weight"]), reverse=True)
        selected = routed[:limit]  # keep original top-N from initial sort

    # ── Conjunction detection ─────────────────────────────────────────────────
    # Skills in orbital conjunction share a close phase_seed: they are both near
    # perihelion at the same moment, making combined use cheaper (lower transfer
    # cost).  This is informational — reported in the route output.
    conjunction_pairs: list[dict[str, object]] = []
    for i, item_a in enumerate(selected):
        slug_a  = str(item_a["slug"])
        sc_a    = results_by_slug.get(slug_a, {}).get("scores", {})
        phase_a = float(sc_a.get("phase_seed", 0.5)) if isinstance(sc_a, dict) else 0.5
        for item_b in selected[i + 1:]:
            slug_b  = str(item_b["slug"])
            sc_b    = results_by_slug.get(slug_b, {}).get("scores", {})
            phase_b = float(sc_b.get("phase_seed", 0.5)) if isinstance(sc_b, dict) else 0.5
            diff = abs(phase_a - phase_b)
            if diff <= CONJUNCTION_WINDOW:
                conjunction_pairs.append({
                    "skills":     [slug_a, slug_b],
                    "phase_diff": round(diff, 3),
                    "strength":   round(1.0 - diff / CONJUNCTION_WINDOW, 3),
                })

    # ── Trojan auto-injection ─────────────────────────────────────────────────
    # Trojans ride in for free when their parent planet is in the selected set.
    # High-albedo parents reflect more light onto their trojans → higher injection weight.
    trojan_injections: list[dict[str, object]] = []
    parent_albedos: dict[str, float] = {
        str(r["slug"]): float(r["scores"].get("albedo", 0.25))  # type: ignore[index]
        for r in results
    }
    # Gate: only inject a trojan if its parent actually scored strongly on THIS task.
    # Prevents the "same 9 trojans appear everywhere" failure when generic planets
    # (api, devops, ux-ui-expert) fall into top-K as bland fallbacks.
    TROJAN_PARENT_RELEVANCE_GATE = 0.18
    for result in results:
        if str(result["class"]) != "trojan":
            continue
        trojan_parent = str(result.get("parent") or result.get("latent_parent") or "")
        trojan_slug   = str(result["slug"])
        parent_task_w = task_context.weight_for(trojan_parent)
        if (trojan_parent in selected_slugs
            and trojan_slug not in selected_slugs
            and parent_task_w >= TROJAN_PARENT_RELEVANCE_GATE):
            parent_albedo  = parent_albedos.get(trojan_parent, 0.25)
            injection_score = round(0.05 + 0.15 * parent_albedo, 3)  # 0.05–0.20 range
            trojan_injections.append({
                "slug":          trojan_slug,
                "class":         "trojan",
                "parent":        trojan_parent,
                "latent_parent": result.get("latent_parent"),
                "task_weight":   round(task_context.weight_for(trojan_slug), 3),
                "route_score":   injection_score,
                "auto_injected": True,
                "albedo_boost":  round(parent_albedo, 3),
                "why":           f"{trojan_slug} is a Trojan companion to {trojan_parent} — injected automatically (parent α={parent_albedo:.2f}).",
            })

    final_selected = selected + trojan_injections

    # ── Confidence signal ─────────────────────────────────────────────────────
    # Honest "I don't know" when nothing strong matches. Clients can surface
    # "we don't cover this yet" instead of confidently serving noise.
    top_primary_score = max((float(s["route_score"]) for s in selected), default=0.0)
    if top_primary_score >= 0.55:
        confidence = "strong"
    elif top_primary_score >= 0.42:
        confidence = "moderate"
    else:
        confidence = "weak"

    return {
        "task":              task_text,
        "profiles":          task_context.profiles,
        "confidence":        confidence,
        "top_primary_score": round(top_primary_score, 3),
        "selected_skills":   final_selected,
        "resonance_boosts":  resonance_boosts,
        "slingshot_boosts":  slingshot_boosts,
        "conjunction_pairs": conjunction_pairs,
        "binary_pairs":      [sorted(list(p)) for p in binary_pairs],
        "prompt_block":      build_prompt_block(task_text, final_selected),
    }


def route_reason(slug: str, orbit_class: str, task_weight: float, parent: object) -> str:
    if orbit_class == "planet":
        return f"{slug} is a broad anchor for this task context."
    if orbit_class == "trojan":
        return f"{slug} is a Trojan companion; auto-injected with {parent}."
    if orbit_class == "comet":
        if task_weight >= 0.60:
            return f"{slug} is at perihelion — strong task match triggers burst activation."
        return f"{slug} is a comet near apoapsis; dormant unless strongly matched."
    if orbit_class == "asteroid_belt":
        return f"{slug} contributes as a fragment, not as the primary owner."
    if orbit_class == "irregular_satellite":
        return f"{slug} is niche or high-drag; use deliberately."
    if parent:
        return f"{slug} is a specialist aligned to this task through {parent}."
    return f"{slug} is aligned to this task."


def build_prompt_block(task_text: str, selected: list[dict[str, object]]) -> str:
    lines = ["Orbital routing context:", f"Task: {task_text}", "Selected skills:"]
    for skill in selected:
        prefix = "[AUTO-INJECTED] " if skill.get("auto_injected") else ""
        lines.append(
            f"- {prefix}{skill['slug']} [{skill['class']}] "
            f"score={skill['route_score']} weight={skill['task_weight']}: {skill['why']}"
        )
    return "\n".join(lines)


# ── Simulation ────────────────────────────────────────────────────────────────

def simulate(
    results: list[dict[str, object]],
    steps: int,
    task_text: str | None = None,
    binary_pairs: set[frozenset] | None = None,
) -> dict[str, object]:
    """
    Deterministic time-step orbital simulation.

    Physics per step:
      - Phase, mass, trust, staleness, health update (existing)
      - Dynamic eccentricity: updated from task_weight vs velocity variance
      - Escape velocity: topology-aware promotion threshold
      - Tidal lock warnings emitted when conditions met
      - Accretion execution: concrete merge recommendations generated
    """
    states = [state_from_result(result) for result in results]
    task_context = build_task_context(task_text)
    if binary_pairs is None:
        binary_pairs = set()
    history: list[dict[str, object]] = []

    for step in range(1, steps + 1):
        step_events: list[dict[str, object]] = []

        belt_groups: dict[str, list[SkillState]] = defaultdict(list)
        for state in states:
            if state.orbit_class == "asteroid_belt":
                belt_groups[state.latent_parent or "unassigned"].append(state)

        for state in states:
            task_weight        = task_context.weight_for(state.slug)
            effective_velocity = clamp(state.velocity + 0.25 * task_weight - 0.05 * state.drag)

            # ── Period-modulated phase update (Kepler's 3rd law) ─────────────
            # Skills with longer orbital periods advance phase more slowly per
            # step — they complete fewer activation cycles per task batch.
            # period_factor ∈ [0.25, 2.0]: planets (T≈1.9) advance ~1.6× faster
            # than distant comets/irregulars (T≈3.0).
            period_factor   = clamp(1.0 / max(state.orbital_period, 0.5), 0.25, 2.0)
            phase_shift     = (0.17 * effective_velocity + 0.06 * task_weight) * period_factor
            state.phase     = round((state.phase + phase_shift) % 1.0, 3)

            task_alignment  = clamp(1.0 - abs(state.phase - 0.5) * 1.4 + 0.35 * task_weight)
            effective_drag  = clamp(state.drag - 0.10 * task_weight)

            # ── Dynamic eccentricity + stellar wind ───────────────────────────
            # Activation variance causes eccentricity to grow or decay.
            # Stellar wind adds a system-specific drift: X-class (Mind) stars
            # have the strongest wind (0.90), pushing skills toward burstier
            # activation patterns than B-class (Forge, 0.70) or G-class (Signal).
            ecc_delta     = 0.04 * abs(task_weight - state.velocity) - 0.015
            star_system   = STAR_SYSTEMS.get(state.star_system, STAR_SYSTEMS["forge"])
            wind_pressure = STELLAR_WIND_ECC_RATE * star_system.stellar_wind * (1.0 - state.velocity)
            state.eccentricity = clamp(state.eccentricity + ecc_delta + wind_pressure)

            decay_pressure = (
                0.030 * state.fragmentation
                + 0.028 * state.overlap_risk
                + 0.020 * effective_drag
                + 0.016 * state.energy_load
                - 0.018 * effective_velocity
                - 0.014 * state.scope
                - 0.020 * task_alignment
                - 0.014 * state.energy_efficiency
                - 0.012 * state.luminance    # high signal density → slower staleness decay
            )
            if state.orbit_class == "asteroid_belt":
                decay_pressure += 0.012
            if state.orbit_class == "planet":
                decay_pressure -= 0.010
            if state.orbit_class == "comet":
                # Comets accrue staleness faster when near apoapsis
                decay_pressure += 0.008 * (1.0 - task_weight)

            trust_delta = (
                0.022 * state.mass
                + 0.018 * state.independence
                - 0.018 * effective_drag
                - 0.030 * state.staleness
                - 0.010 * state.energy_load
                + 0.012 * state.energy_efficiency
                + 0.020 * task_alignment
            )
            mass_delta = (
                0.012 * state.scope
                + 0.010 * state.independence
                - 0.012 * state.overlap_risk
                - 0.012 * state.fragmentation
                + 0.014 * task_weight
                + 0.008 * state.scattering   # widely-activated skills accrue mass faster
            )

            state.staleness = clamp(state.staleness + decay_pressure)
            state.trust     = clamp(state.trust + trust_delta)
            state.mass      = clamp(state.mass + mass_delta)
            state.health    = clamp(
                0.46
                + 0.30 * state.trust
                + 0.22 * state.mass
                - 0.24 * state.staleness
                - 0.14 * effective_drag
                + 0.10 * task_alignment
            )

            # ── Tidal lock warning ────────────────────────────────────────────
            dep = parent_dependency_ratio(state.slug, state.latent_parent)
            if (
                state.independence < TIDAL_LOCK_INDEPENDENCE
                and dep >= TIDAL_LOCK_DEPENDENCY
                and state.trust > 0.55
            ):
                step_events.append({
                    "type":   "tidal_lock_warning",
                    "skill":  state.slug,
                    "detail": (
                        f"independence={state.independence:.2f} dep_ratio={dep:.2f} — "
                        f"candidate for absorption into {state.latent_parent}"
                    ),
                })

        # ── Structural events ─────────────────────────────────────────────────
        for state in states:
            previous_class = state.orbit_class
            task_weight    = task_context.weight_for(state.slug)

            # Escape velocity: heavier parent requires more momentum to escape.
            # trust reduces needed momentum (earned credibility).
            parent_mass = next(
                (s.mass for s in states if s.slug == state.latent_parent), 0.50
            )
            escape_vel = 0.55 + 0.15 * parent_mass - 0.10 * state.trust
            adjusted_score = (
                state.planet_score
                + 0.20 * state.trust
                - 0.18 * state.staleness
                + 0.10 * task_weight
            )

            if (
                previous_class == "moon"
                and adjusted_score >= escape_vel
                and state.mass >= 0.70
                and state.scope >= 0.50
                and state.independence >= 0.56
                and state.fragmentation <= 0.38
            ):
                state.orbit_class = "planet"
                state.parent = None
                step_events.append({
                    "type":   "promotion",
                    "skill":  state.slug,
                    "detail": (
                        f"moon -> planet "
                        f"(score={adjusted_score:.3f} >= escape_vel={escape_vel:.3f}, "
                        f"parent_mass={parent_mass:.3f})"
                    ),
                })
                continue

            if (
                previous_class == "moon"
                and state.belt_score + 0.16 * state.staleness - 0.10 * task_weight >= 0.56
                and state.fragmentation >= 0.42
                and state.overlap_risk >= 0.36
                and state.scope <= 0.47
            ):
                state.orbit_class = "asteroid_belt"
                state.parent = None
                step_events.append({
                    "type":   "demotion",
                    "skill":  state.slug,
                    "detail": "moon -> asteroid_belt",
                })
                continue

            if (
                previous_class == "planet"
                and state.staleness >= 0.58
                and state.mass <= 0.62
                and state.trust <= 0.63
            ):
                state.orbit_class = "moon"
                state.parent = state.latent_parent
                step_events.append({
                    "type":   "decay",
                    "skill":  state.slug,
                    "detail": "planet -> moon",
                })
                continue

            if (
                previous_class == "irregular_satellite"
                and state.health >= 0.64
                and state.drag <= 0.45
                and state.trust >= 0.64
            ):
                state.orbit_class = "moon"
                state.parent = state.latent_parent
                step_events.append({
                    "type":   "stabilization",
                    "skill":  state.slug,
                    "detail": "irregular_satellite -> moon",
                })

        # ── Habitable zone stability ──────────────────────────────────────────
        # A planet whose scope drifts outside its star system's habitable zone
        # is structurally at risk — too narrow (inner edge) or too broad (outer).
        for state in states:
            if state.orbit_class != "planet":
                continue
            sys_obj  = STAR_SYSTEMS.get(state.star_system, STAR_SYSTEMS["forge"])
            hz_lo, hz_hi = sys_obj.habitable_zone
            if not (hz_lo <= state.scope <= hz_hi):
                step_events.append({
                    "type":   "habitable_zone_warning",
                    "skill":  state.slug,
                    "detail": (
                        f"planet scope={state.scope:.3f} outside "
                        f"{state.star_system} habitable_zone [{hz_lo:.2f}, {hz_hi:.2f}]"
                    ),
                })

        # ── Accretion execution ───────────────────────────────────────────────
        for anchor, group in belt_groups.items():
            if len(group) < 2:
                continue
            average_mass   = sum(item.mass for item in group) / len(group)
            average_health = sum(item.health for item in group) / len(group)
            if average_mass >= 0.56 and average_health >= 0.60:
                fragments = sorted(item.slug for item in group)
                prefix = _common_prefix(fragments)
                if prefix:
                    proposed_slug = f"{prefix}-components"
                elif anchor and anchor != "unassigned":
                    proposed_slug = f"{anchor.split('-')[0]}-components"
                else:
                    proposed_slug = "merged-components"
                fragment_paths = [f"/opt/skills/{f}/SKILL.md" for f in fragments]
                step_events.append({
                    "type":          "accretion",
                    "skill":         anchor,
                    "proposed_moon": proposed_slug,
                    "fragments":     fragments,
                    "parent":        anchor,
                    "fragment_paths": fragment_paths,
                    "action": (
                        f"merge {fragment_paths} "
                        f"into /opt/skills/{proposed_slug}/SKILL.md"
                    ),
                    "detail": (
                        f"belt fragments [{', '.join(fragments)}] qualify for "
                        f"accretion into moon '{proposed_slug}' "
                        f"(avg_mass={average_mass:.3f}, avg_health={average_health:.3f})"
                    ),
                })

        history.append({
            "step":   step,
            "events": step_events,
            "states": [
                {
                    "slug":        state.slug,
                    "class":       state.orbit_class,
                    "parent":      state.parent,
                    "task_weight": round(task_context.weight_for(state.slug), 3),
                    "phase":       round(state.phase, 3),
                    "mass":        round(state.mass, 3),
                    "trust":       round(state.trust, 3),
                    "staleness":   round(state.staleness, 3),
                    "health":      round(state.health, 3),
                    "eccentricity": round(state.eccentricity, 3),
                }
                for state in states
            ],
        })

    return {
        "steps":        steps,
        "task_context": {"raw_text": task_context.raw_text, "profiles": task_context.profiles},
        "events":       [event for step_data in history for event in step_data["events"]],
        "final_states": history[-1]["states"] if history else [],
        "history":      history,
    }


# ── Discovery ─────────────────────────────────────────────────────────────────

def discover_skills(root: Path) -> list[Skill]:
    return sorted(
        (load_skill(path.parent) for path in root.glob("*/SKILL.md")),
        key=lambda skill: skill.slug,
    )


# ── Display ───────────────────────────────────────────────────────────────────

def detect_conjunctions(results: list[dict[str, object]]) -> list[dict[str, object]]:
    """Return all skill pairs currently in orbital conjunction (phase_seed proximity).

    Conjunction = both skills near perihelion simultaneously → low transfer cost
    to use them together.  Sorted by strength (1.0 = perfect alignment).
    """
    pairs: list[dict[str, object]] = []
    for i, a in enumerate(results):
        sc_a = a.get("scores")
        if not isinstance(sc_a, dict):
            continue
        phase_a = float(sc_a.get("phase_seed", 0.5))
        slug_a  = str(a["slug"])
        for b in results[i + 1:]:
            sc_b = b.get("scores")
            if not isinstance(sc_b, dict):
                continue
            phase_b = float(sc_b.get("phase_seed", 0.5))
            slug_b  = str(b["slug"])
            diff = abs(phase_a - phase_b)
            if diff <= CONJUNCTION_WINDOW:
                pairs.append({
                    "skills":     [slug_a, slug_b],
                    "phase_diff": round(diff, 3),
                    "strength":   round(1.0 - diff / CONJUNCTION_WINDOW, 3),
                })
    return sorted(pairs, key=lambda p: float(p["strength"]), reverse=True)


_CLASS_SYMBOL = {
    "planet":            "●",
    "moon":              "◉",
    "trojan":            "⬡",
    "comet":             "☄",
    "asteroid_belt":     "⬤",
    "irregular_satellite": "◌",
}


def print_table(results: list[dict[str, object]]) -> None:
    headers = ("skill", "class", "parent", "scope", "mass", "drag", "α alb", "τ trn", "L lum", "σ sct", "flags")
    rows = []
    for result in results:
        scores = result["scores"]
        assert isinstance(scores, dict)
        flags = []
        if result.get("roche_disrupted"):
            flags.append("roche")
        if result.get("tidal_lock"):
            flags.append("tidal")
        if result.get("hill_sphere_escaped"):
            flags.append("hill")
        symbol = _CLASS_SYMBOL.get(str(result["class"]), "?")
        rows.append((
            str(result["slug"]),
            f"{symbol} {result['class']}",
            str(result["parent"] or "-"),
            f"{scores['scope']:.3f}",
            f"{scores['mass']:.3f}",
            f"{scores['drag']:.3f}",
            f"{scores.get('albedo', 0.0):.3f}",
            f"{scores.get('transmittance', 0.0):.3f}",
            f"{scores.get('luminance', 0.0):.3f}",
            f"{scores.get('scattering', 0.0):.3f}",
            ",".join(flags) or "-",
        ))
    widths = [max(len(h), *(len(r[i]) for r in rows)) for i, h in enumerate(headers)]
    print("  ".join(h.ljust(widths[i]) for i, h in enumerate(headers)))
    print("  ".join("-" * widths[i] for i in range(len(headers))))
    for row in rows:
        print("  ".join(row[i].ljust(widths[i]) for i in range(len(headers))))


def print_physics_summary(
    results: list[dict[str, object]],
    binary_pairs: set[frozenset],
) -> None:
    """Print a summary of all active physics phenomena."""
    tidal  = [r["slug"] for r in results if r.get("tidal_lock")]
    roche  = [r["slug"] for r in results if r.get("roche_disrupted")]
    hill   = [r["slug"] for r in results if r.get("hill_sphere_escaped")]
    trojans = [r["slug"] for r in results if r["class"] == "trojan"]
    comets  = [r["slug"] for r in results if r["class"] == "comet"]

    conjunctions = detect_conjunctions(results)
    hz_unstable  = [str(r["slug"]) for r in results if not r.get("habitable_zone_stable", True)]

    print("\n── Physics Summary ──────────────────────────────────────────")
    print(f"  Binary systems  : {[sorted(list(p)) for p in binary_pairs] or 'none'}")
    print(f"  Trojan points   : {trojans or 'none'}")
    print(f"  Comets          : {comets or 'none'}")
    print(f"  Tidal lock      : {tidal or 'none'}")
    print(f"  Roche disrupted : {roche or 'none'}")
    print(f"  Hill escaped    : {hill or 'none'}")
    print(f"  HZ unstable     : {hz_unstable or 'none'}")
    if conjunctions:
        top_c = conjunctions[:4]
        print("  Conjunctions    :")
        for c in top_c:
            print(f"    {c['skills'][0]} ↔ {c['skills'][1]}  Δφ={c['phase_diff']:.3f}  str={c['strength']:.3f}")
    if RESONANCE_PAIRS:
        top_res = sorted(RESONANCE_PAIRS.items(), key=lambda x: x[1], reverse=True)[:5]
        print("  Top resonances  :")
        for (a, b), strength in top_res:
            print(f"    {a} ↔ {b}  ({strength:.3f})")

    # ── Optical summary ───────────────────────────────────────────────────────
    def _top(prop: str, n: int = 3) -> list[str]:
        ranked = sorted(
            results,
            key=lambda r: float(r["scores"].get(prop, 0.0)),  # type: ignore[index]
            reverse=True,
        )
        return [f"{r['slug']}({r['scores'].get(prop, 0.0):.2f})" for r in ranked[:n]]  # type: ignore[index]

    print("\n── Optical Properties ───────────────────────────────────────")
    print(f"  α Albedo (brightest reflectors)       : {', '.join(_top('albedo'))}")
    print(f"  τ Transmittance (most transparent)    : {', '.join(_top('transmittance'))}")
    print(f"  L Luminance (highest signal density)  : {', '.join(_top('luminance'))}")
    print(f"  σ Scattering (widest activation spread): {', '.join(_top('scattering'))}")

    print("\n── Orbital Mechanics ────────────────────────────────────────")
    planets_sorted = sorted(
        [r for r in results if str(r.get("class")) == "planet"],
        key=lambda r: float(r["scores"].get("semi_major_axis", 1.0))
              if isinstance(r.get("scores"), dict) else 1.0,
    )
    for p in planets_sorted:
        sc  = p["scores"]
        assert isinstance(sc, dict)
        a   = float(sc.get("semi_major_axis", 0.8))
        T   = float(sc.get("orbital_period",  2.0))
        hz  = "✓ HZ" if p.get("habitable_zone_stable", True) else "⚠ outside HZ"
        inc = float(sc.get("inclination", 0.15))
        print(f"  {str(p['slug']):<22}  a={a:.3f} AU  T={T:.3f}  i={inc:.3f}  {hz}")


def print_simulation(simulation: dict[str, object]) -> None:
    events      = simulation["events"]
    final_states = simulation["final_states"]
    task_context = simulation["task_context"]
    assert isinstance(events, list)
    assert isinstance(final_states, list)
    assert isinstance(task_context, dict)

    print(f"steps: {simulation['steps']}")
    print(f"task: {task_context['raw_text'] or '-'}")
    print(f"profiles: {task_context['profiles'] or '-'}")
    print("events:")
    if not events:
        print("  none")
    else:
        for event in events:
            assert isinstance(event, dict)
            etype = event["type"]
            if etype == "accretion":
                print(f"  - accretion: {event.get('skill')} → proposed moon '{event.get('proposed_moon')}'")
                print(f"      action: {event.get('action')}")
            else:
                print(f"  - {etype}: {event['skill']} ({event.get('detail', '')})")

    headers = ("skill", "class", "parent", "task", "phase", "mass", "trust", "staleness", "health", "ecc")
    rows = []
    for state in final_states:
        assert isinstance(state, dict)
        rows.append((
            str(state["slug"]),
            str(state["class"]),
            str(state["parent"] or "-"),
            f"{state['task_weight']:.3f}",
            f"{state['phase']:.3f}",
            f"{state['mass']:.3f}",
            f"{state['trust']:.3f}",
            f"{state['staleness']:.3f}",
            f"{state['health']:.3f}",
            f"{state.get('eccentricity', 0.0):.3f}",
        ))
    widths = [max(len(h), *(len(r[i]) for r in rows)) for i, h in enumerate(headers)]
    print("final state:")
    print("  ".join(h.ljust(widths[i]) for i, h in enumerate(headers)))
    print("  ".join("-" * widths[i] for i in range(len(headers))))
    for row in rows:
        print("  ".join(row[i].ljust(widths[i]) for i in range(len(headers))))


def print_route(route: dict[str, object]) -> None:
    print(f"task: {route['task']}")
    print(f"profiles: {route['profiles'] or '-'}")
    if route.get("binary_pairs"):
        print(f"binary pairs: {route['binary_pairs']}")
    if route.get("resonance_boosts"):
        print(f"resonance boosts: {route['resonance_boosts']}")
    if route.get("slingshot_boosts"):
        sl = route["slingshot_boosts"]
        assert isinstance(sl, dict)
        top_sl = sorted(sl.items(), key=lambda x: x[1], reverse=True)[:4]
        print(f"slingshot targets: {dict(top_sl)}")
    if route.get("conjunction_pairs"):
        for c in route["conjunction_pairs"]:
            assert isinstance(c, dict)
            print(f"conjunction: {c['skills']}  strength={c['strength']}")
    print("selected:")
    for skill in route["selected_skills"]:
        prefix = "[↳ trojan] " if skill.get("auto_injected") else ""
        print(
            f"  {prefix}- {skill['slug']} [{skill['class']}] "
            f"score={skill['route_score']} weight={skill['task_weight']} "
            f"parent={skill.get('parent') or '-'}"
        )
        print(f"    {skill['why']}")
    print("prompt block:")
    print(route["prompt_block"])


# ── Galaxy display ───────────────────────────────────────────────────────────

_SPECTRAL_SYMBOL = {"B": "☀", "G": "☀", "X": "✦"}
_SYSTEM_COLOR_TAG = {"forge": "blue-white", "signal": "yellow-amber", "mind": "violet-white"}

def print_galaxy_map(results: list[dict[str, object]]) -> None:
    """ASCII map of the Meridian Galaxy — skills grouped by star system."""
    _CLASS_SYM = {
        "planet": "●", "moon": "◉", "trojan": "⬡",
        "comet": "☄", "asteroid_belt": "⬤", "irregular_satellite": "◌",
    }
    # Group by system
    systems_order = ["forge", "signal", "mind"]
    by_system: dict[str, list[dict]] = {s: [] for s in systems_order}
    bridges: list[dict] = []
    for r in results:
        sys_slug = str(r.get("star_system", "forge"))
        by_system.setdefault(sys_slug, []).append(r)
        if r.get("lagrange_systems"):
            bridges.append(r)

    print(f"\n{'═' * 70}")
    print(f"  ★  {GALAXY_NAME} GALAXY  ★   ({len(results)} skills across {len(by_system)} star systems)")
    print(f"{'═' * 70}")

    for sys_slug in systems_order:
        members = by_system.get(sys_slug, [])
        if not members:
            continue
        star = STAR_SYSTEMS[sys_slug]
        sym = _SPECTRAL_SYMBOL.get(star.spectral_class, "☀")
        print(f"\n  {sym} {star.name.upper()} SYSTEM  "
              f"[{star.spectral_class}-class · {star.color}]  "
              f"temp={star.temperature:.2f} lum={star.luminosity:.2f}")
        print(f"  {'─' * 60}")

        # Sort: planets first, then by class
        order = ["planet", "moon", "trojan", "comet", "asteroid_belt", "irregular_satellite"]
        members_sorted = sorted(members, key=lambda r: (order.index(str(r["class"])) if str(r["class"]) in order else 9, str(r["slug"])))

        for r in members_sorted:
            sym_c   = _CLASS_SYM.get(str(r["class"]), "?")
            parent  = str(r["parent"] or "-")
            lp      = float(r.get("lagrange_potential", 0.0))
            bridge  = f" ⇌ {'+'.join(r['lagrange_systems'])}" if r.get("lagrange_systems") else ""
            lp_str  = f" [L={lp:.2f}]" if lp > 0.1 else ""
            scores  = r["scores"]
            assert isinstance(scores, dict)
            print(f"    {sym_c}  {r['slug']:<26}  {str(r['class']):<20}  "
                  f"→{parent:<18}  α={scores.get('albedo',0):.2f} "
                  f"L={scores.get('luminance',0):.2f}{bridge}{lp_str}")

    if bridges:
        print(f"\n  ⇌  LAGRANGE BRIDGES  ({len(bridges)} cross-system skills)")
        print(f"  {'─' * 60}")
        for r in sorted(bridges, key=lambda r: -float(r.get("lagrange_potential", 0))):
            systems_str = " ↔ ".join(r.get("lagrange_systems", []))
            lp = float(r.get("lagrange_potential", 0.0))
            print(f"    {r['slug']:<28}  {systems_str:<30}  potential={lp:.3f}")

    print(f"\n{'═' * 70}\n")


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description="Classify skill orbits under /opt/skills.")
    parser.add_argument("--json",     action="store_true", help="Emit JSON instead of a table.")
    parser.add_argument("--skill",    help="Classify only one skill directory slug.")
    parser.add_argument("--simulate", type=int, default=0, help="Run deterministic time-step simulation.")
    parser.add_argument("--task",     help="Task text to bias simulation and routing.")
    parser.add_argument("--route",    action="store_true", help="Return task-routed skills.")
    parser.add_argument("--limit",    type=int, default=5, help="Max skills to return for --route.")
    parser.add_argument("--physics",  action="store_true", help="Print physics summary after table.")
    parser.add_argument("--galaxy",   action="store_true", help="Print Meridian Galaxy map.")
    parser.add_argument("--system",     choices=["forge", "signal", "mind"], help="Filter to one star system.")
    parser.add_argument("--candidates", help="Comma-separated slug pre-filter from embedding layer.")
    args = parser.parse_args()

    all_skills = discover_skills(ROOT)

    if args.skill:
        target_skills = [s for s in all_skills if s.slug == args.skill]
        if not target_skills:
            raise SystemExit(f"Unknown skill slug: {args.skill}")
    elif args.candidates:
        # Embedding pre-filter: only classify the candidate set
        # but keep all_skills intact for parent/trojan resolution
        candidate_set  = set(args.candidates.split(","))
        target_skills  = [s for s in all_skills if s.slug in candidate_set]
    else:
        target_skills = all_skills

    results = [classify(skill, all_skills) for skill in target_skills]

    # Post-classify passes (mutate results in-place)
    apply_hill_sphere_correction(results, all_skills)
    binary_pairs = detect_binary_systems(results)

    # System filter (applied after classification so lagrange bridges still resolve)
    if args.system and not args.route:
        system_set = {args.system}
        results = [
            r for r in results
            if str(r.get("star_system", "forge")) in system_set
            or any(s in system_set for s in r.get("lagrange_systems", []))
        ]

    if args.galaxy:
        all_results = [classify(skill, all_skills) for skill in all_skills]
        apply_hill_sphere_correction(all_results, all_skills)
        print_galaxy_map(all_results)
        if args.physics:
            print_physics_summary(all_results, binary_pairs)
    elif args.route:
        if not args.task:
            raise SystemExit("--route requires --task")
        systems_filter = [args.system] if args.system else None
        route = route_task(results, args.task, limit=args.limit, binary_pairs=binary_pairs, systems=systems_filter)
        if args.json:
            print(json.dumps(route, indent=2, default=str))
        else:
            print_route(route)
    elif args.simulate > 0:
        simulation = simulate(results, args.simulate, task_text=args.task, binary_pairs=binary_pairs)
        if args.json:
            print(json.dumps(simulation, indent=2, default=str))
        else:
            print_simulation(simulation)
    elif args.json:
        print(json.dumps(results, indent=2, default=str))
    else:
        print_table(results)
        if args.physics:
            print_physics_summary(results, binary_pairs)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
# (no-op append to trigger engine_hash change for new latex skill)
