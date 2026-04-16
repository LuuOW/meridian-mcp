---
name: nextjs-dashboard
description: Next.js 15+ App Router dashboard skill — server/client components, mobile nav, polling, data tables, skeleton states, and production-grade dashboard UX patterns
---

# nextjs-dashboard

Expert knowledge for building production-ready dashboards with Next.js App Router (v15+), React 19, Tailwind CSS v4, and token-driven design systems.

## 1) App Router Mental Model

- **Server Components** (default): fetch data, access server resources, no hooks, no browser APIs
- **Client Components** (`'use client'`): hooks, events, browser APIs, polling, real-time state
- **Rule**: push `'use client'` as far down the tree as possible — layouts and page shells should stay server-side
- **Data fetching**: server components fetch directly; client components use `useEffect` + `fetch` or SWR/React Query

```tsx
// page.tsx — Server Component (no 'use client')
import { DomainList } from './DomainList' // client island

export default async function DomainsPage() {
  const domains = await getDomains() // server-side fetch
  return <DomainList initialDomains={domains} />
}

// DomainList.tsx — Client Component
'use client'
export function DomainList({ initialDomains }: { initialDomains: Domain[] }) {
  const [domains, setDomains] = useState(initialDomains)
  // ... polling, mutations
}
```

## 2) Mobile Navigation Pattern (Sidebar + Drawer)

The most common gap in dashboard UIs. Sidebar must work as a drawer on mobile.

```tsx
'use client'
import { useState, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { Menu, X } from 'lucide-react'

export function Sidebar() {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  // Close drawer on navigation
  useEffect(() => { setOpen(false) }, [pathname])

  // Prevent body scroll when drawer open
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [open])

  return (
    <>
      {/* Mobile top bar */}
      <header className="sticky top-0 z-40 flex items-center justify-between px-4 h-14 lg:hidden"
        style={{ background: '#0c1a2e', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <Logo />
        <button onClick={() => setOpen(true)} aria-label="Open menu"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-white/70 hover:bg-white/10">
          <Menu size={20} />
        </button>
      </header>

      {/* Backdrop */}
      {open && (
        <div className="fixed inset-0 z-40 bg-black/60 lg:hidden backdrop-blur-sm"
          onClick={() => setOpen(false)} />
      )}

      {/* Sidebar — drawer on mobile, sticky on desktop */}
      <aside className={`
        fixed inset-y-0 left-0 z-50 w-[280px] transition-transform duration-300 ease-out
        lg:sticky lg:top-0 lg:h-screen lg:translate-x-0
        ${open ? 'translate-x-0' : '-translate-x-full'}
      `}>
        <button onClick={() => setOpen(false)} className="absolute right-3 top-3 lg:hidden ...">
          <X size={18} />
        </button>
        {/* nav content */}
      </aside>
    </>
  )
}
```

## 3) App Layout Shell

```tsx
// app/(app)/layout.tsx — Server Component
import { Sidebar } from '@/components/Sidebar'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession()
  if (!session) redirect('/login')

  return (
    <div className="lg:grid lg:grid-cols-[280px_minmax(0,1fr)]">
      <Sidebar />
      <main className="min-h-screen min-h-svh min-w-0">
        {children}
      </main>
    </div>
  )
}
```

Use `min-h-svh` (small viewport height) instead of `min-h-screen` for mobile browsers with dynamic toolbars.

## 4) Polling Pattern

```tsx
'use client'
function usePolling<T>(fetcher: () => Promise<T>, interval = 4000) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      try {
        const result = await fetcher()
        if (!cancelled) setData(result)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Error')
      }
    }

    poll()
    const id = setInterval(poll, interval)
    return () => { cancelled = true; clearInterval(id) }
  }, [fetcher, interval])

  return { data, error }
}
```

Always:
- Set `cancelled = true` in cleanup
- Include a `catch` block (silent failures hide real errors)
- Clear the interval on unmount

## 5) Skeleton Loading States

Match the skeleton to the real layout to prevent layout shift:

```tsx
function MetricCardSkeleton() {
  return (
    <div className="glass-card rounded-[var(--radius-lg)] p-5 flex flex-col gap-4 min-h-[110px]">
      <div className="h-2.5 w-20 animate-pulse rounded bg-[color-mix(in_srgb,var(--muted)_14%,transparent)]" />
      <div className="h-10 w-16 animate-pulse rounded bg-[color-mix(in_srgb,var(--muted)_14%,transparent)]" />
    </div>
  )
}

// Usage
{loading
  ? Array.from({ length: 4 }).map((_, i) => <MetricCardSkeleton key={i} />)
  : metrics.map((m) => <MetricCard key={m.label} {...m} />)
}
```

## 6) Data Table Best Practices

Tables in dashboards need:
- Horizontal scroll wrapper (mobile)
- Sticky header on long lists
- Empty state
- Loading state that matches column count

```tsx
// Always wrap in scroll container
<div className="overflow-x-auto rounded-[inherit]">
  <table className="min-w-full border-collapse">
    <thead className="sticky top-0">
      <tr>
        {headers.map(h => (
          <th key={h} className="px-4 py-3 text-left text-[0.68rem] font-bold uppercase tracking-[0.16em] text-[var(--muted)] whitespace-nowrap">
            {h}
          </th>
        ))}
      </tr>
    </thead>
    <tbody>
      {rows.map((row, i) => (
        <tr key={i} className="group border-t border-[var(--border)]">
          {row.map((cell, j) => (
            <td key={j} className="px-4 py-3 text-sm transition-colors group-hover:bg-[color-mix(in_srgb,var(--accent)_5%,transparent)]">
              {cell}
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  </table>
</div>
```

## 7) Grid Layout Patterns

```css
/* Metric grid — responsive fill */
.metric-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--space-4);
}

/* Panel grid — two-column on desktop */
.panel-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-4);
}
@media (min-width: 1024px) {
  .panel-grid { grid-template-columns: 1fr 1fr; }
}

/* Page shell — responsive gutter */
.page-shell {
  max-width: 1280px;
  margin-inline: auto;
  padding: var(--space-6) var(--space-4);
}
@media (min-width: 640px) {
  .page-shell { padding: var(--space-8) var(--space-6); }
}
@media (min-width: 1280px) {
  .page-shell { padding: var(--space-10) var(--space-8); }
}
```

## 8) Error States

Every data-fetching component needs an error path:

```tsx
if (error) return (
  <div className="rounded-[var(--radius)] border border-[color-mix(in_srgb,var(--red)_28%,transparent)] bg-[color-mix(in_srgb,var(--red)_8%,transparent)] px-4 py-3 text-sm text-[var(--red)]">
    {error}
  </div>
)
```

## 9) Theme Flash Prevention (SSR)

Inject a blocking script before React hydrates to set the theme class:

```tsx
// app/layout.tsx
<html suppressHydrationWarning>
  <head>
    <script dangerouslySetInnerHTML={{
      __html: `(function(){var t=localStorage.getItem('theme')||'dark';document.documentElement.classList.toggle('dark',t==='dark')})()`,
    }} />
  </head>
```

`suppressHydrationWarning` on `<html>` silences the class mismatch warning — expected and safe here.

## 10) Dashboard UX Checklist

- [ ] Mobile navigation works (drawer/sheet, closes on route change)
- [ ] All grids/cards have gap — no touching borders
- [ ] Page content has horizontal padding on all breakpoints
- [ ] Tables have cell padding and horizontal scroll wrapper
- [ ] Every async section has loading skeleton and error state
- [ ] Polling intervals cleaned up on unmount (no memory leaks)
- [ ] Empty states for all lists/tables
- [ ] `min-h-svh` not `min-h-screen` on main content
- [ ] Theme toggle works without flash on reload
- [ ] All interactive controls have `focus-visible` ring
