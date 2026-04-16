---
name: tailwind-css expert
description: Tailwind CSS — configuration, token strategy, CSS variable theming, color-mix patterns, button variants, card utilities, dark mode, production quality checklist
---

# Tailwind CSS Skill Guide

## Objective

Define a repeatable Tailwind workflow for fast, consistent, accessible UI delivery. Includes modern CSS variable theming patterns used in production dashboards.

## 1) Configuration Baseline

```bash
npm i -D tailwindcss @tailwindcss/vite   # Tailwind v4
# or
npm i -D tailwindcss postcss autoprefixer # Tailwind v3
```

- Create stylesheet entry: `@import "tailwindcss";` (v4) or `@tailwind base/components/utilities` (v3).
- Configure source scanning: v4 auto-detects; v3 uses `content` globs in `tailwind.config.js`.
- Add shared breakpoint/container conventions early to avoid layout drift.

## 2) CSS Variable Token System

Tailwind works best with CSS vars as semantic tokens:

```css
/* globals.css — shadcn/ui convention */
:root {
  --background: 0 0% 100%;
  --foreground: 222.2 84% 4.9%;
  --primary: 221.2 83.2% 53.3%;
  --primary-foreground: 210 40% 98%;
  --muted: 210 40% 96.1%;
  --muted-foreground: 215.4 16.3% 46.9%;
  --border: 214.3 31.8% 91.4%;
  --ring: 221.2 83.2% 53.3%;
  --radius: 0.5rem;
}
.dark {
  --background: 222.2 84% 4.9%;
  --foreground: 210 40% 98%;
  --muted: 217.2 32.6% 17.5%;
  --border: 217.2 32.6% 17.5%;
}
```

Wire into `tailwind.config.js`:
```js
theme: {
  extend: {
    colors: {
      background: 'hsl(var(--background))',
      foreground: 'hsl(var(--foreground))',
      primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
      muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
      border: 'hsl(var(--border))',
    },
    borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)', sm: 'calc(var(--radius) - 4px)' },
  },
}
```

## 3) Alternative: Raw CSS Variable Theme (no hsl wrapper)

For custom dashboards that don't use shadcn:

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
.dark { /* override each var */ }
```

Reference in Tailwind arbitrary values:
```tsx
<div className="text-[var(--fg)] bg-[var(--bg-elevated)] border-[var(--border)]" />
```

## 4) color-mix() for Tinted Backgrounds

Modern CSS `color-mix()` replaces opacity hacks:

```tsx
// 13% tinted background, 28% tinted border — no rgba needed
className="bg-[color-mix(in_srgb,var(--accent)_13%,transparent)] border-[color-mix(in_srgb,var(--accent)_28%,transparent)]"

// Semi-transparent elevated card
className="bg-[color-mix(in_srgb,var(--bg-elevated)_94%,transparent)]"
```

Use underscores for spaces in Tailwind arbitrary values: `color-mix(in_srgb,...)`.

## 5) Component Examples

### Button with full variant set

```tsx
type BtnVariant = 'default' | 'secondary' | 'ghost' | 'danger' | 'outline'
type BtnSize    = 'sm' | 'md' | 'lg' | 'icon'

const variantStyles: Record<BtnVariant, string> = {
  default:
    'border-transparent bg-[var(--accent)] text-[var(--accent-fg)] shadow-[0_2px_10px_color-mix(in_srgb,var(--accent)_28%,transparent)] hover:brightness-[1.08]',
  secondary:
    'border-[var(--border-strong)] bg-[color-mix(in_srgb,var(--bg-elevated)_96%,transparent)] text-[var(--fg)] hover:bg-[var(--bg-elevated)]',
  ghost:
    'border-transparent bg-transparent text-[var(--muted)] hover:border-[var(--border)] hover:bg-[color-mix(in_srgb,var(--bg-elevated)_80%,transparent)] hover:text-[var(--fg)]',
  danger:
    'border-transparent bg-[var(--red)] text-white shadow-[0_2px_10px_color-mix(in_srgb,var(--red)_28%,transparent)] hover:brightness-[1.06]',
  outline:
    'border-[var(--border-strong)] bg-transparent text-[var(--fg)] hover:bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] hover:border-[var(--accent)]',
}

const sizeStyles: Record<BtnSize, string> = {
  sm:   'h-8 px-3 text-xs',
  md:   'h-9 px-4 text-sm',
  lg:   'h-11 px-6 text-sm',
  icon: 'h-9 w-9 p-0',
}

export function Btn({ children, variant = 'default', size = 'md', disabled, onClick, className }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'inline-flex items-center justify-center rounded-full border font-semibold',
        'transition duration-150 ease-out active:scale-[0.97]',
        variantStyles[variant], sizeStyles[size],
        disabled && 'cursor-not-allowed opacity-50',
        className
      )}
    >
      {children}
    </button>
  )
}
```

### Glass Card

```tsx
<section className="glass-card rounded-[var(--radius-lg)] p-5">
  {children}
</section>
```
```css
.glass-card {
  background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);
  border: 1px solid var(--border);
  backdrop-filter: blur(12px);
}
```

### Kicker / Overline label

```tsx
<div className="kicker">{label}</div>
```
```css
.kicker {
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--muted);
}
```

## 6) Dark Sidebar with Translucent Nav

```tsx
const SIDEBAR_BG = 'linear-gradient(180deg, #0c1a2e 0%, #0d2240 50%, #081628 100%)'

// Active nav item: white pill on dark background
<Link
  style={active
    ? { background: 'rgba(255,255,255,0.95)', color: '#0c1a2e' }
    : { color: 'rgba(255,255,255,0.6)' }
  }
  className={clsx(
    'flex items-center gap-3 rounded-[var(--radius-sm)] px-3 py-2.5 text-sm font-medium transition-all duration-150',
    !active && 'hover:bg-white/[0.07]'
  )}
>
```

## 7) Responsive Layout Conventions

```tsx
// Mobile-first grid patterns
<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">   // KPI strip
<div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">   // card grid
<div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.4fr_1fr]">       // asymmetric 2-col

// Flex with responsive direction
<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
```

## 8) Integration Guide

- **shadcn/ui**: align Tailwind tokens (`--background`, `--foreground`, radius, spacing) before generating components.
- **Astro**: import Tailwind stylesheet in root layout; keep islands lean.
- **React/Next**: load global Tailwind entry in top-level app file.
- **Framer Motion**: keep utility classes for static style; motion props for animation state only.

## 9) Quality Checklist

- No missing `focus-visible` state on custom controls.
- Layout stable at `sm`, `md`, `lg`, `xl`, and ultra-wide.
- Contrast and state visibility verified for hover/focus/disabled/error.
- Dark mode: all CSS vars overridden, no hardcoded colour values.
- Arbitrary `w-[317px]` values only if tied to a documented design constraint.
- Repeated utility patterns extracted into reusable components before merge.
