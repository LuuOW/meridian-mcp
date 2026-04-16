---
name: shadcn/ui expert
description: shadcn/ui composable component system — setup, token strategy, card patterns, form composition, real project examples from lead-gen dashboard
keywords: ["shadcn", "shadcn/ui", "composable", "component", "system", "setup", "token", "strategy", "card", "patterns", "form", "composition", "real", "project", "examples", "lead-gen"]
orb_class: trojan
---

# shadcn/ui Expert Skill Guide

## Objective

Use shadcn/ui as a composable, copy-owned component baseline. Customise design tokens to match the product; never treat the library as a locked black box.

## 1) Setup and Configuration

```bash
npx shadcn@latest init
```

- Confirm aliases (`@/components`, `@/lib`) and Tailwind config are correct.
- Component output paths:
  - UI primitives: `src/components/ui`
  - Feature components: `src/components/features` or `src/components/<domain>`
- Keep `components.json` committed and stable across teammates.
- Add the `cn` merge helper in `src/lib/utils.ts`:

```ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)) }
```

## 2) Token and Theme Strategy

Override CSS variables in `globals.css` — this is how shadcn separates colour from component code:

```css
:root {
  --background: 0 0% 100%;
  --foreground: 222.2 84% 4.9%;
  --primary: 221.2 83.2% 53.3%;
  --muted: 210 40% 96.1%;
  --muted-foreground: 215.4 16.3% 46.9%;
  --border: 214.3 31.8% 91.4%;
  --ring: 221.2 83.2% 53.3%;
  --radius: 0.5rem;
}
.dark {
  --background: 222.2 84% 4.9%;
  --foreground: 210 40% 98%;
}
```

Maintain one source of truth for radius, spacing, and typography rhythm.

## 3) Card Composition Pattern

shadcn Card is a composition — always use Card/CardHeader/CardTitle/CardContent:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

function StatCard({ icon: Icon, label, value, variant = 'slate' }: {
  icon: React.ElementType
  label: string
  value: string | number
  variant?: 'slate' | 'red' | 'green'
}) {
  const colors = {
    slate: 'text-slate-600',
    red:   'text-red-500',
    green: 'text-green-600',
  }
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

### KPI Strip (4 stat cards in a grid)

```tsx
<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
  <StatCard icon={TrendingUp}    label="Meetings/mo" value={kpis.monthly_meetings ?? '—'} />
  <StatCard icon={Target}        label="Reply rate"  value={kpis.target_reply_rate ? `${kpis.target_reply_rate}%` : '—'} variant="green" />
  <StatCard icon={AlertTriangle} label="Max bounce"  value={kpis.max_bounce_rate   ? `${kpis.max_bounce_rate}%`   : '—'} variant="red" />
  <StatCard icon={DollarSign}    label="Budget"      value={campaign.budget ?? '—'} />
</div>
```

## 4) TagPills Component

Render string arrays as pill badges with optional muted/strikethrough variant:

```tsx
function TagPills({ tags, muted = false }: { tags: string[]; muted?: boolean }) {
  if (!tags?.length) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((t) => (
        <span
          key={t}
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-medium',
            muted
              ? 'bg-slate-100 text-slate-400 line-through'
              : 'bg-blue-50 text-blue-700 border border-blue-200'
          )}
        >
          {t}
        </span>
      ))}
    </div>
  )
}
```

## 5) Collapsible Category Sections

Use `Set<string>` state to track which sections are collapsed; Chevron icon flips on toggle:

```tsx
import { ChevronDown, ChevronRight } from 'lucide-react'

const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['advanced', 'testing']))

function toggleSection(key: string) {
  setCollapsed(prev => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })
}

// In render
<div className="border rounded-lg overflow-hidden">
  <button
    onClick={() => toggleSection('linkedin')}
    className="w-full flex items-center justify-between px-4 py-3 bg-sky-50 border-b border-sky-200"
  >
    <span className="text-sm font-semibold text-sky-700 flex items-center gap-2">
      <LinkedinIcon className="h-4 w-4" /> LinkedIn Sourcing
    </span>
    {collapsed.has('linkedin')
      ? <ChevronRight className="h-4 w-4 text-sky-500" />
      : <ChevronDown  className="h-4 w-4 text-sky-500" />}
  </button>
  {!collapsed.has('linkedin') && <div className="p-4">{/* content */}</div>}
</div>
```

## 6) Expandable Table Rows

Use `Fragment` to inject a second detail row without breaking table semantics:

```tsx
import { Fragment, useState } from 'react'

function ExpandableRow({ run }: { run: ExecutionRun }) {
  const [open, setOpen] = useState(false)
  return (
    <Fragment>
      <TableRow
        className="cursor-pointer hover:bg-muted/50"
        onClick={() => setOpen(o => !o)}
      >
        <TableCell>{open ? <ChevronDown /> : <ChevronRight />}</TableCell>
        <TableCell>{run.skill_name}</TableCell>
        <TableCell>{run.status}</TableCell>
        <TableCell>{run.created_at}</TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={4} className="bg-muted/30 px-6 py-3">
            <pre className="text-xs whitespace-pre-wrap font-mono text-muted-foreground">
              {run.error_message || JSON.stringify(run.output_data, null, 2)}
            </pre>
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  )
}
```

## 7) Dialog Flow

```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export function DeleteDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="destructive">Delete</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this item?</DialogTitle>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  )
}
```

## 8) Form Field Composition

```tsx
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function EmailField() {
  return (
    <div className="grid gap-2">
      <Label htmlFor="email">Work email</Label>
      <Input id="email" type="email" placeholder="name@company.com" />
    </div>
  )
}
```

## 9) Category Color Coding System

For dashboards with multiple functional categories, define a colour map keyed to category strings:

```tsx
const categoryColor: Record<string, string> = {
  setup:            'bg-blue-50   border-blue-200   text-blue-700',
  enrichment:       'bg-purple-50 border-purple-200 text-purple-700',
  outbound:         'bg-green-50  border-green-200  text-green-700',
  linkedin_sourcing:'bg-sky-50    border-sky-200    text-sky-700',
  analytics:        'bg-orange-50 border-orange-200 text-orange-700',
  testing:          'bg-amber-50  border-amber-200  text-amber-700',
}
// Usage: className={cn('border rounded-lg', categoryColor[category])}
```

## 10) Integration Guide

- **Tailwind CSS**: required; keep utility scales aligned with token overrides.
- **Framer Motion**: wrap container elements with `motion.div` while preserving shadcn semantics and focus management.
- **react-hook-form + zod**: pair for typed validation and predictable UX states.
- **Astro islands**: works inside React/Vue/Svelte islands with correct peer deps.

## 11) Maintenance Rules

- Generate only components you need; avoid dumping the entire catalog.
- Wrap primitives into domain-level components before product usage.
- Keep business logic out of `src/components/ui`.
- Regenerate upstream components intentionally — do not blindly overwrite local customisations.
- Test keyboard and screen-reader paths after each component update.
