---
name: Framer Motion
description: Framer Motion animation library — setup, motion principles, staggered lists, exit transitions, shared layout, gesture feedback, accessibility
keywords: ["framer", "motion", "animation", "library", "setup", "principles", "staggered", "lists", "exit", "transitions", "shared", "layout", "gesture", "feedback", "accessibility"]
orb_class: trojan
---

# Framer Motion Skill Guide

## Objective

Deliver meaningful UI motion that improves clarity and feedback without degrading accessibility or performance.

## 1) Setup and Baseline

```bash
npm i framer-motion
```

- Import from `framer-motion` and use `motion.*` wrappers selectively.
- Respect user preference with `useReducedMotion` and reduced-motion variants.
- Define shared transitions in a small motion config module for consistency.

## 2) Motion Principles

- Animate for meaning: state change, hierarchy, feedback, orientation.
- Keep durations tight (typically 120ms to 320ms) for UI interactions.
- Favour opacity/transform animations; avoid expensive layout thrashing.
- Use spring transitions for tactile micro-interactions and tween for deterministic sequencing.

## 3) Core Animation Patterns

### Staggered Reveal

```tsx
import { motion } from 'framer-motion'

const list = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.06, delayChildren: 0.04 },
  },
}
const item = {
  hidden: { opacity: 0, y: 8 },
  show:   { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

export function StaggeredList({ items }: { items: string[] }) {
  return (
    <motion.ul initial="hidden" animate="show" variants={list} className="space-y-2">
      {items.map((label) => (
        <motion.li key={label} variants={item} className="rounded border p-3">
          {label}
        </motion.li>
      ))}
    </motion.ul>
  )
}
```

### Exit Transitions with AnimatePresence

```tsx
import { AnimatePresence, motion } from 'framer-motion'

export function Toast({ open, message }: { open: boolean; message: string }) {
  return (
    <AnimatePresence mode="wait">
      {open ? (
        <motion.div
          key="toast"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.18 }}
          className="rounded-md bg-slate-900 px-4 py-2 text-white"
        >
          {message}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
```

### Page Transition Shell

```tsx
// components/PageTransition.tsx
'use client'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, type ReactNode } from 'react'

export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.animation = 'none'
    void el.offsetHeight   // force reflow to restart animation
    el.style.animation = ''
  }, [pathname])

  return (
    <div ref={ref} className="animate-fade-up">
      {children}
    </div>
  )
}
```

This approach re-triggers a CSS animation on route change without needing the Framer Motion overhead for every page. Use Framer Motion `AnimatePresence` when you need exit animations across pages.

### Gesture Feedback

```tsx
<motion.button
  whileHover={{ scale: 1.03 }}
  whileTap={{ scale: 0.97 }}
  transition={{ type: 'spring', stiffness: 400, damping: 17 }}
  className="btn-primary"
>
  Run skill
</motion.button>
```

### Shared Layout Transition

```tsx
import { motion, LayoutGroup } from 'framer-motion'

// Wrap the list in LayoutGroup; add layoutId to the selected indicator
<LayoutGroup>
  {items.map((item) => (
    <div key={item.id} className="relative">
      {selected === item.id && (
        <motion.div
          layoutId="selection"
          className="absolute inset-0 rounded-lg bg-primary/10"
          transition={{ type: 'spring', bounce: 0.2, duration: 0.4 }}
        />
      )}
      <button onClick={() => setSelected(item.id)}>{item.label}</button>
    </div>
  ))}
</LayoutGroup>
```

## 4) Reduced Motion / Accessibility

```tsx
import { useReducedMotion } from 'framer-motion'

function AnimatedCard({ children }: { children: React.ReactNode }) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      initial={{ opacity: 0, y: reduce ? 0 : 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduce ? 0.01 : 0.22 }}
    >
      {children}
    </motion.div>
  )
}
```

## 5) Integration Guide

- **Tailwind CSS**: combine static styling via classes with state animation via Motion props.
- **shadcn/ui**: animate wrapper/container layers and preserve primitive accessibility behaviour.
- **Route/page transitions**: define route-level motion shells to avoid per-page duplication.
- **Data-heavy screens**: animate only key affordances to prevent render overhead.

## 6) Performance and Accessibility Checks

- Confirm reduced-motion path is functional and readable.
- Cap simultaneous animated elements for list/grid views.
- Profile with browser DevTools when animating large collections.
- Ensure focus order and keyboard interaction remain unchanged by animated wrappers.
- Avoid motion patterns that obscure important content or introduce latency to actions.
