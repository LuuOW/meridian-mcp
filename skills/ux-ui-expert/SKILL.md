---
name: ux/ui expert
description: Framework-agnostic frontend + UX/UI skill matrix covering Next.js App Router, Astro, design systems, mobile nav, accessibility, and dashboard patterns
keywords: ["expert", "framework", "ux", "ui", "next", "app", "router", "astro", "framework-agnostic", "frontend", "ux/ui", "skill", "matrix", "covering", "design", "systems", "mobile", "nav", "accessibility"]
orb_class: planet
---

# ux/ui expert

Frontend + UX/UI Skill Matrix — applicable to Next.js App Router, Astro, and React projects.

## 1) Framework Context

### Next.js App Router
- Server Components by default — no hooks, no browser APIs, fetch data directly
- `'use client'` only at interaction boundaries (forms, polling, real-time, toggles)
- Layouts stay server-side; push client components as far down the tree as possible
- Use `min-h-svh` on main shells (handles mobile browser dynamic toolbars)

### Astro
- Islands architecture: static shell + selectively hydrated React islands
- `client:load` → immediate, `client:idle` → non-critical, `client:visible` → below fold
- Zero JS by default — every hydrated component must justify its cost
- Layout, nav, header: pure `.astro` — no `'use client'` equivalent needed

### Shared Principles
- Composition over configuration for UI primitives
- Token-driven design (CSS variables) — never hardcode colors or spacing values
- Mobile-first: smallest breakpoint first, larger overrides progressively
- Semantic HTML first — ARIA only where semantic HTML is insufficient

## 2) Design System Engineering

- Build reusable primitives: Button, Card, Badge, Table, EmptyState, Skeleton
- Token system: color, spacing, typography, radius, shadow, motion
- Theming (light/dark) via `.dark` class on `<html>` + CSS variable overrides in `.dark {}`
- Never hardcode colors — always `var(--token-name)`
- `box-sizing: border-box` globally — predictable sizing
- Interaction: meaningful transitions (120–320ms), feedback without noise
- `prefers-reduced-motion`: always disable/minimize animations when set

## 3) UX Quality Bar

- Define user goal, UX constraints, success criteria before implementation
- Every interactive section must have all states: loading, empty, success, failure, validation
- Conversion-oriented hierarchy: primary action visible, above fold, high contrast
- Mobile ergonomics: tap targets ≥44px, readable density, minimal-friction forms
- Error prevention first; clear recovery pathways second

## 4) Mobile Navigation (Dashboard Pattern)

The most commonly missed UX gap. Sidebar must work as a drawer on mobile:

```tsx
'use client'
export function Sidebar() {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  useEffect(() => { setOpen(false) }, [pathname])
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [open])

  return (
    <>
      <header className="sticky top-0 z-40 flex items-center justify-between px-4 h-14 lg:hidden">
        <Logo />
        <button onClick={() => setOpen(true)} aria-label="Open menu"><Menu size={20} /></button>
      </header>
      {open && <div className="fixed inset-0 z-40 bg-black/60 lg:hidden" onClick={() => setOpen(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-50 w-[280px] transition-transform duration-300
        lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        {/* nav content */}
      </aside>
    </>
  )
}
```

## 5) Spacing and Grid System (4pt scale)

```css
/* Page shell — always fill responsive padding, never leave empty breakpoints */
.page-shell {
  max-width: 1280px;
  margin-inline: auto;
  padding: var(--space-6) var(--space-4);
}
@media (min-width: 640px)  { .page-shell { padding: var(--space-8) var(--space-6); } }
@media (min-width: 1280px) { .page-shell { padding: var(--space-10) var(--space-8); } }

/* Grids always need explicit gap */
.metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-4); }
.panel-grid  { display: grid; gap: var(--space-4); }
@media (min-width: 1024px) { .panel-grid { grid-template-columns: 1fr 1fr; } }
```

## 6) Table Standards

Every table must have: cell padding, horizontal scroll wrapper, hover state, empty state.

```css
.data-table th { padding: var(--space-3) var(--space-4) var(--space-2); }
.data-table td { padding: var(--space-3) var(--space-4); border-top: 1px solid var(--border); }
```

Wrap all tables: `<div class="overflow-x-auto rounded-[inherit]"><table>...</table></div>`

## 7) Async/Polling Pattern

```tsx
useEffect(() => {
  let cancelled = false
  const poll = async () => {
    try {
      const data = await fetchSomething()
      if (!cancelled) setData(data)
    } catch {
      // always include catch — silent errors hide real problems
    }
  }
  poll()
  const id = setInterval(poll, 4000)
  return () => { cancelled = true; clearInterval(id) }
}, [])
```

## 8) Accessibility

- All icon-only buttons need `aria-label`
- `focus-visible` ring on all interactive controls
- WCAG AA contrast minimums (4.5:1 text, 3:1 UI elements)
- Keyboard navigation through all interactive elements
- `prefers-reduced-motion` respected

## 9) Component Checklist (per component)

- [ ] Loading skeleton that matches real layout (prevents CLS)
- [ ] Error state with actionable message
- [ ] Empty state with icon, title, optional CTA
- [ ] Responsive at 375px, 768px, 1280px
- [ ] `focus-visible` ring on all controls
- [ ] Mobile touch targets ≥44px

## 10) Delivery Standards

- Implement against design tokens first, bespoke CSS second
- Never add JS that doesn't have clear UX justification
- Ship only when: responsive, accessible, all async states handled
- Every list/table: defined empty state
- Every async section: loading skeleton + error path
