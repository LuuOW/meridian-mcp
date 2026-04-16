---
name: context-compaction
description: Reduce context entropy and token burn by compacting stale state, preserving only reusable signal, and reshaping long tasks into short high-coherence context windows
keywords: ["context", "compaction", "reduce", "entropy", "token", "burn", "compacting", "stale", "state", "preserving", "only", "reusable", "signal", "reshaping", "long", "tasks"]
orb_class: trojan
---

# context-compaction

Compaction is not summarization for its own sake. It is energy recovery.

The goal is to preserve decision-useful signal while discarding stale context mass.

## 1) Use When

- a task has shifted phases
- earlier exploration is no longer needed in full
- repeated tool results are crowding out active work
- a worker or route is carrying too much irrelevant history
- token burn is rising faster than useful progress

## 2) Keep vs Drop

Keep:

- chosen approach
- file paths that still matter
- constraints and assumptions
- exact failures still being debugged
- verification commands and outcomes

Drop:

- dead-end explorations
- duplicate file summaries
- verbose tool output once the conclusion is known
- alternative approaches already rejected
- long prose that can be collapsed into one line

## 3) Compaction Pattern

```text
Before:
- 8 files explored
- 4 rejected theories
- 3 repeated test outputs
- 1 active fix path

After:
- active fix path
- 2 relevant files
- exact failing test
- 1 sentence on rejected theory only if it prevents rework
```

## 4) Phase Boundary Rule

Compact aggressively at:

- research -> implementation
- implementation -> verification
- pre-release handoff
- after a large failed attempt

Do not carry research noise into implementation unless it is still causally relevant.

## 5) High-Value Compaction Formats

- decision log
- current target files
- active hypothesis
- exact next command
- known no-go paths

## 6) Anti-Patterns

- compressing away the one error string that matters
- keeping giant excerpts "just in case"
- summarizing every explored file equally
- treating compaction as archival completeness instead of operational focus

## 7) Checklist

- [ ] Removed stale exploration from the active context
- [ ] Preserved the chosen path and why
- [ ] Kept exact errors and commands still needed for verification
- [ ] Dropped duplicate summaries and obsolete alternatives
- [ ] Reduced token load without reducing decision quality
