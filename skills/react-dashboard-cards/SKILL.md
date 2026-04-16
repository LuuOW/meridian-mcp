---
name: react dashboard cards
description: Production-grade React dashboard card patterns — StatCard, KPI strip, domain progress cards, metric bars, badge system, skeleton states, glass-card CSS variables. Extracted from lead-gen and seo-geo-aeo dashboards.
keywords: ["react", "dashboard", "cards", "production", "statcard", "kpi", "css", "extracted", "production-grade", "card", "patterns", "strip", "domain", "progress", "metric", "bars", "badge", "system"]
orb_class: trojan
---

# React Dashboard Cards Skill Guide

## Objective

Build data-rich admin dashboards with consistent, scannable card layouts. Patterns extracted from two production codebases: a B2B lead-gen engine (Vite + shadcn/ui) and a SEO pipeline dashboard (Next.js App Router + custom CSS variables).

---

## 1) Design Token Systems

### shadcn/ui approach (Tailwind + CSS vars)
```css
:root {
  --primary: 221.2 83.2% 53.3%;
  --muted-foreground: 215.4 16.3% 46.9%;
  --border: 214.3 31.8% 91.4%;
  --radius: 0.5rem;
}
```
Components reference `hsl(var(--primary))` etc.

### Custom CSS variable approach (seo-geo-aeo pattern)
```css
:root {
  --fg:           #0f172a;
  --muted:        #64748b;
  --bg:           #ffffff;
  --bg-elevated:  #f8fafc;
  --border:       rgba(0,0,0,0.08);
  --border-strong:rgba(0,0,0,0.14);
  --accent:       #0d6d8a;
  --accent-fg:    #ffffff;
  --green:        #3ecf8e;
  --yellow:       #eaaf2a;
  --red:          #f57265;
  --blue:         #46afc8;
  --radius:       10px;
  --radius-sm:    6px;
  --radius-lg:    16px;
}
.dark { /* override all */ }
```

Use `color-mix(in srgb, var(--accent) 13%, transparent)` for tinted backgrounds — no opacity hacks needed.

---

## 2) Glass Card Component

```tsx
// SEO dashboard pattern — custom CSS vars, no shadcn
import clsx from 'clsx'

export function Card({ children, className, style }) {
  return (
    <section
      className={clsx('glass-card rounded-[var(--radius-lg)] p-5', className)}
      style={style}
    >
      {children}
    </section>
  )
}
```

```css
/* globals.css */
.glass-card {
  background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);
  border: 1px solid var(--border);
  backdrop-filter: blur(12px);
}
```

---

## 3) StatCard — Icon + Label + Value

### shadcn/ui version
```tsx
function StatCard({
  icon: Icon,
  label,
  value,
  variant = 'slate',
}: {
  icon: React.ElementType
  label: string
  value: string | number
  variant?: 'slate' | 'red' | 'green'
}) {
  const colors = { slate: 'text-slate-600', red: 'text-red-500', green: 'text-green-600' }
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="flex items-center gap-3">
          <Icon className={cn('h-5 w-5', colors[variant])} />
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
            <p className={cn('text-2xl font-semibold tabular-nums', colors[variant])}>{value}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
```

### CSS-var version (SEO dashboard Stat)
```tsx
export function Stat({ label, value, sub, accent }: {
  label: string
  value: string | number
  sub?: string
  accent?: string   // CSS gradient string for bottom bar
}) {
  return (
    <div className="relative flex min-h-[110px] flex-col justify-between gap-4">
      <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--muted)]">
        {label}
      </div>
      <div>
        <div
          className="text-[2.5rem] font-medium leading-none tabular-nums text-[var(--fg)]"
          style={{ fontFamily: 'var(--font-mono, monospace)', letterSpacing: '-0.03em' }}
        >
          {value}
        </div>
        {sub && <div className="mt-2 text-[0.78rem] text-[var(--muted)]">{sub}</div>}
      </div>
      {accent && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px] rounded-full opacity-60"
          style={{ background: accent }}
        />
      )}
    </div>
  )
}
```

---

## 4) KPI Strip

```tsx
// 4-card stat strip at the top of an overview tab
<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
  <StatCard icon={TrendingUp}    label="Meetings/mo" value={kpis.monthly_meetings ?? '—'} />
  <StatCard icon={Target}        label="Reply rate"  value={kpis.target_reply_rate ? `${kpis.target_reply_rate}%` : '—'} variant="green" />
  <StatCard icon={AlertTriangle} label="Max bounce"  value={kpis.max_bounce_rate   ? `${kpis.max_bounce_rate}%`   : '—'} variant="red" />
  <StatCard icon={DollarSign}    label="Budget"      value={campaign.budget ?? '—'} />
</div>
```

---

## 5) Badge System

### shadcn/ui-compatible pills
```tsx
type BadgeColor = 'green' | 'yellow' | 'red' | 'blue' | 'muted'

export function Badge({ label, color = 'muted' }: { label: string; color?: BadgeColor }) {
  const styles: Record<BadgeColor, string> = {
    green:  'bg-[color-mix(in_srgb,var(--green)_13%,transparent)] text-[var(--green)] border-[color-mix(in_srgb,var(--green)_28%,transparent)]',
    yellow: 'bg-[color-mix(in_srgb,var(--yellow)_13%,transparent)] text-[var(--yellow)] border-[color-mix(in_srgb,var(--yellow)_28%,transparent)]',
    red:    'bg-[color-mix(in_srgb,var(--red)_13%,transparent)] text-[var(--red)] border-[color-mix(in_srgb,var(--red)_28%,transparent)]',
    blue:   'bg-[color-mix(in_srgb,var(--blue)_13%,transparent)] text-[var(--blue)] border-[color-mix(in_srgb,var(--blue)_28%,transparent)]',
    muted:  'bg-[color-mix(in_srgb,var(--muted)_10%,transparent)] text-[var(--muted)] border-[color-mix(in_srgb,var(--muted)_18%,transparent)]',
  }
  return (
    <span className={clsx('inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-semibold tracking-[0.05em]', styles[color])}>
      {label}
    </span>
  )
}
```

### Status badge with lookup map
```tsx
export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; color: BadgeColor }> = {
    active:    { label: 'Active',    color: 'green'  },
    paused:    { label: 'Paused',    color: 'yellow' },
    error:     { label: 'Error',     color: 'red'    },
    draft:     { label: 'Draft',     color: 'muted'  },
    completed: { label: 'Completed', color: 'blue'   },
  }
  const mapped = map[status] ?? { label: status.replace(/_/g, ' '), color: 'muted' as const }
  return <Badge label={mapped.label} color={mapped.color} />
}
```

---

## 6) Domain / Entity Progress Card

Card with title + status badge + description + metric sub-cards with progress bars:

```tsx
<article className="rounded-[var(--radius)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-elevated)_94%,transparent)] p-5">
  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-xl font-semibold tracking-[-0.04em] text-[var(--fg)]">
          {domain.name}
        </h3>
        <Badge label={statusLabel} color={statusColor} />
      </div>
      <p className="mt-3 text-sm leading-6 text-[var(--muted)]">{statusText}</p>
    </div>
    <Btn variant={canAct ? 'default' : 'secondary'} disabled={!canAct} onClick={handleAction}>
      {actionLabel}
    </Btn>
  </div>

  {/* Metric sub-cards */}
  <div className="mt-5 grid gap-4 md:grid-cols-2">
    {metrics.map(({ key, label, current, threshold, met }) => (
      <div key={key} className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_34%,transparent)] p-4">
        <div className="flex items-start justify-between gap-3 text-sm">
          <div>
            <div className="font-medium text-[var(--fg)]">{label}</div>
            <div className="mt-1 text-xs text-[var(--muted)]">{met ? 'Met' : 'Required'}</div>
          </div>
          <span className={met ? 'text-[var(--green)]' : 'text-[var(--muted)]'}>
            {current} / {threshold}
          </span>
        </div>
        <div className="metric-bar mt-4">
          <span
            style={{
              width: `${Math.min((current / threshold) * 100, 100)}%`,
              background: met
                ? 'linear-gradient(90deg, var(--green), color-mix(in srgb, var(--green) 55%, white 45%))'
                : 'linear-gradient(90deg, var(--yellow), var(--blue))',
            }}
          />
        </div>
      </div>
    ))}
  </div>
</article>
```

```css
/* metric-bar utility */
.metric-bar {
  height: 6px;
  background: var(--border);
  border-radius: 999px;
  overflow: hidden;
}
.metric-bar > span {
  display: block;
  height: 100%;
  border-radius: 999px;
  transition: width 0.4s ease;
}
```

---

## 7) Hero Banner with Inline KPI Tiles

Dark gradient hero with semi-transparent stat tiles:

```tsx
<div
  className="relative overflow-hidden rounded-[20px]"
  style={{ background: 'linear-gradient(135deg, #0c1a2e 0%, #0d2240 55%, #0a1930 100%)' }}
>
  {/* Ambient glow blobs */}
  <div aria-hidden className="pointer-events-none absolute inset-0">
    <div className="absolute -left-16 -top-16 h-56 w-56 rounded-full blur-3xl" style={{ background: 'rgba(13,109,138,0.25)' }} />
    <div className="absolute -bottom-16 right-0  h-48 w-48 rounded-full blur-3xl" style={{ background: 'rgba(24,112,176,0.20)' }} />
  </div>

  <div className="relative px-7 py-8 sm:px-9">
    <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
      <div>
        <div className="text-[10px] font-bold uppercase tracking-[0.2em] mb-2" style={{ color: 'rgba(255,255,255,0.4)' }}>
          Mission Control
        </div>
        <h1 className="text-2xl font-semibold tracking-[-0.03em]" style={{ color: 'rgba(255,255,255,0.95)' }}>
          Dashboard Title
        </h1>
      </div>

      {/* KPI tiles */}
      <div className="flex flex-wrap gap-3">
        {[
          { label: 'Total', value: 12, bg: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.9)', accent: 'rgba(255,255,255,0.4)' },
          { label: 'Ready', value: 5,  bg: 'rgba(62,207,142,0.10)', color: '#3ecf8e', accent: 'rgba(62,207,142,0.6)' },
        ].map(({ label, value, bg, color, accent }) => (
          <div key={label} className="rounded-[8px] px-5 py-3 min-w-[100px] text-center" style={{ background: bg, border: `1px solid ${color}22` }}>
            <div className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: accent }}>{label}</div>
            <div className="text-2xl font-medium leading-none tabular-nums" style={{ color, fontFamily: 'var(--font-mono, monospace)' }}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  </div>
</div>
```

---

## 8) Skeleton States

Always provide skeletons for async data — match the exact layout of the real component:

```tsx
/** Shimmer base class */
.sk {
  background: linear-gradient(90deg, var(--border) 25%, color-mix(in srgb, var(--border) 60%, white 40%) 50%, var(--border) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.4s infinite;
  border-radius: 4px;
}
@keyframes shimmer { to { background-position: -200% 0 } }

// React component
export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('sk', className)} />
}

// Stat skeleton — matches Stat component dimensions
export function SkeletonStat() {
  return (
    <Card>
      <div className="flex min-h-[110px] flex-col justify-between gap-4">
        <Skeleton className="h-2.5 w-20" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-16" />
          <Skeleton className="h-2.5 w-28" />
        </div>
      </div>
    </Card>
  )
}

// Domain card skeleton — 4 metric sub-cards
export function SkeletonDomainCard() {
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-3 w-64 mt-1" />
        </div>
        <Skeleton className="h-9 w-28 rounded-full" />
      </div>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        {[0,1,2,3].map((i) => (
          <div key={i} className="rounded-[var(--radius-sm)] border border-[var(--border)] p-4 flex flex-col gap-3">
            <div className="flex justify-between">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-12" />
            </div>
            <Skeleton className="h-2 w-full rounded-full" />
          </div>
        ))}
      </div>
    </div>
  )
}
```

---

## 9) Live Polling in Sidebar Panel

```tsx
// Real-time pipeline status widget inside sidebar
function PipelinePanel() {
  const [activity, setActivity] = useState<PipelineActivity | null>(null)

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      const data = await getPipelineActivity()
      if (!cancelled) setActivity(data)
    }
    poll()
    const id = setInterval(poll, 4000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  if (!activity || activity.total === 0) return null

  const pct = Math.round((activity.completed / activity.total) * 100)
  return (
    <div className="rounded-[var(--radius)] p-4" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)' }}>
      <div className="h-1.5 rounded-full mb-3" style={{ background: 'rgba(255,255,255,0.10)' }}>
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, background: activity.running ? 'linear-gradient(90deg, #eaaf2a, #f5c842)' : 'linear-gradient(90deg, #3ecf8e, #52d9a0)' }}
        />
      </div>
      {/* stage list with status dots */}
      {activity.stages.map((stage) => (
        <div key={stage.id} className="flex items-center gap-2 text-xs">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: stage.status === 'done' ? '#3ecf8e' : stage.status === 'running' ? '#eaaf2a' : 'rgba(255,255,255,0.25)' }} />
          <span className="flex-1 truncate">{stage.label}</span>
          <span className="tabular-nums">{stage.done}/{stage.total}</span>
        </div>
      ))}
    </div>
  )
}
```

---

## 10) Empty State

```tsx
export function EmptyState({ icon, title, description, action }: {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-[var(--radius)] border border-dashed border-[var(--border-strong)] px-6 py-14 text-center">
      {icon && (
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-[var(--accent)]">
          {icon}
        </div>
      )}
      <div>
        <div className="text-sm font-semibold text-[var(--fg)]">{title}</div>
        {description && <div className="mt-1 text-xs leading-5 text-[var(--muted)]">{description}</div>}
      </div>
      {action}
    </div>
  )
}
```

---

## 11) Three-Step How-It-Works Row

```tsx
const steps = [
  { icon: <CircleDashed size={18} />, title: '1. Collect', body: 'Gather evidence before spending budget.' },
  { icon: <Target       size={18} />, title: '2. Qualify', body: 'Hit required thresholds to unlock the action.' },
  { icon: <ArrowRight   size={18} />, title: '3. Trigger', body: 'Deliberate action — not a polling loop.' },
]

<div className="grid gap-4 lg:grid-cols-3">
  {steps.map((s) => (
    <Card key={s.title}>
      <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)]">
        {s.icon}
      </div>
      <h3 className="mt-5 text-lg font-semibold tracking-[-0.03em] text-[var(--fg)]">{s.title}</h3>
      <p className="mt-3 text-sm leading-7 text-[var(--muted)]">{s.body}</p>
    </Card>
  ))}
</div>
```

---

## 12) Layout Grid Conventions

```css
/* panel-grid: standard dashboard vertical flow */
.panel-grid {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  padding: 1.5rem;
}

/* sidebar shell: sticky full-height sidebar */
.sidebar-shell {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  padding: 1.25rem;
  height: 100%;
  overflow: hidden;
}
```

Multi-column grid inside a panel:
```tsx
// 3-column intelligence row
<div className="grid grid-cols-1 gap-4 md:grid-cols-3">
  <Card>...</Card>
  <Card>...</Card>
  <Card>...</Card>
</div>
```

---

## 13) Dark Sidebar with Active Nav

```tsx
const SIDEBAR_BG = 'linear-gradient(180deg, #0c1a2e 0%, #0d2240 50%, #081628 100%)'

{nav.map(({ href, label, icon: Icon }) => {
  const active = href === '/' ? path === '/' : path.startsWith(href)
  return (
    <Link
      key={href}
      href={href}
      className={clsx(
        'flex items-center gap-3 rounded-[var(--radius-sm)] px-3 py-2.5 text-sm font-medium transition-all duration-150',
        active ? 'shadow-sm' : 'hover:bg-white/[0.07]'
      )}
      style={active
        ? { background: 'rgba(255,255,255,0.95)', color: '#0c1a2e' }
        : { color: 'rgba(255,255,255,0.6)' }
      }
    >
      <span
        className="flex h-7 w-7 items-center justify-center rounded-lg transition-all duration-150"
        style={active
          ? { background: 'rgba(13,109,138,0.15)', color: '#0d6d8a' }
          : { background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)' }
        }
      >
        <Icon size={14} />
      </span>
      {label}
    </Link>
  )
})}
```

---

## 14) Score Bar Component

Inline progress bar with colour thresholds — useful for prospect scores, quality metrics:

```tsx
function ScoreBar({ score }: { score: number }) {
  const fill =
    score >= 70 ? 'bg-green-500' :
    score >= 40 ? 'bg-yellow-500' :
                  'bg-red-500'
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-20 rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full rounded-full transition-all ${fill}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs text-muted-foreground w-7 text-right tabular-nums">{score}</span>
    </div>
  )
}
```

---

## 15) BulletList Component

Render string arrays as a readable bullet list — for selling angles, capabilities, limitations:

```tsx
function BulletList({ items }: { items: string[] }) {
  if (!items?.length) return null
  return (
    <ul className="space-y-1.5">
      {items.map((item) => (
        <li key={item} className="flex items-start gap-2 text-sm text-slate-700">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
          {item}
        </li>
      ))}
    </ul>
  )
}
```

---

## 16) Status Badge Color Tables

Consistent semantic colouring: each status uses `bg-{color}-100 text-{color}-700 border-{color}-200`.

**Campaign / job status:**
```tsx
const statusBadge: Record<string, string> = {
  draft:     'bg-slate-100  text-slate-700  border-slate-200',
  active:    'bg-green-100  text-green-700  border-green-200',
  paused:    'bg-yellow-100 text-yellow-700 border-yellow-200',
  completed: 'bg-blue-100   text-blue-700   border-blue-200',
  running:   'bg-yellow-100 text-yellow-700 border-yellow-200',
  failed:    'bg-red-100    text-red-700    border-red-200',
  queued:    'bg-slate-100  text-slate-700  border-slate-200',
}
```

**Prospect status:**
```tsx
const prospectBadge: Record<string, string> = {
  new:        'bg-slate-100 text-slate-700 border-slate-200',
  qualified:  'bg-blue-100  text-blue-700  border-blue-200',
  contacted:  'bg-yellow-100 text-yellow-700 border-yellow-200',
  converted:  'bg-green-100  text-green-700  border-green-200',
  discarded:  'bg-red-100    text-red-700    border-red-200',
}
```

**Email verification status:**
```tsx
const emailBadge: Record<string, string> = {
  verified:    'bg-green-100  text-green-700  border-green-200',
  unverified:  'bg-slate-100  text-slate-700  border-slate-200',
  catch_all:   'bg-yellow-100 text-yellow-700 border-yellow-200',
  invalid:     'bg-red-100    text-red-700    border-red-200',
  unknown:     'bg-slate-100  text-slate-700  border-slate-200',
}
```

**Response category:**
```tsx
const responseBadge: Record<string, string> = {
  interested:      'bg-green-100  text-green-700  border-green-200',
  more_info:       'bg-blue-100   text-blue-700   border-blue-200',
  talk_later:      'bg-yellow-100 text-yellow-700 border-yellow-200',
  not_interested:  'bg-red-100    text-red-700    border-red-200',
  ooo:             'bg-slate-100  text-slate-700  border-slate-200',
  unsubscribe:     'bg-orange-100 text-orange-700 border-orange-200',
  unclassified:    'bg-slate-100  text-slate-700  border-slate-200',
}
```

---

## 17) FieldRow Component

Label + value wrapper — the standard pattern for overview cards:

```tsx
function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  )
}

// NotSet fallback
function NotSet() {
  return <p className="text-xs text-muted-foreground italic">Not set</p>
}

// Usage
<FieldRow label="Industries">
  {campaign.icp_industries?.length
    ? <TagPills tags={campaign.icp_industries} />
    : <NotSet />}
</FieldRow>
```
