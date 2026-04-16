---
name: astro-expert
description: Astro framework expertise — islands architecture, SSR/hybrid modes, React integration, performance, and production-ready frontend scaffolding
---

# astro-expert

Expert knowledge for building production-ready frontends with Astro — combining static rendering, selective hydration, and React islands for interactive components.

## 1) Core Architecture Principles

- **Islands architecture**: static Astro shell + selectively hydrated React islands
- Zero JS by default — every kilobyte of hydrated JS must justify itself with UX value
- `client:load` — hydrate immediately (forms, critical interactivity)
- `client:idle` — hydrate when browser is idle (non-critical widgets)
- `client:visible` — hydrate when in viewport (below-the-fold islands)
- `client:only="react"` — skip SSR entirely for fully client-driven components (SSE consumers, real-time UIs)

## 2) Project Structure

```
src/
├── layouts/          # Astro layout shells (zero JS)
├── pages/            # File-based routing (.astro files)
│   └── [id].astro    # Dynamic segments
├── components/
│   ├── layout/       # Pure Astro layout primitives
│   ├── ui/           # Shared React primitives (Button, Card, Badge)
│   └── features/     # React islands — business-logic components
├── lib/              # Utilities, API client, hooks
│   ├── utils.ts      # cn() helper, formatters
│   ├── api.ts        # Backend API client
│   └── useEventStream.ts  # SSE hook
├── styles/
│   ├── tokens.css    # CSS custom properties (color, spacing, radius)
│   └── app.css       # Tailwind entry + base overrides
└── types/            # Shared TypeScript interfaces
```

## 3) Configuration Baseline

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  integrations: [
    react(),
    tailwind({ applyBaseStyles: false }),
  ],
  output: 'hybrid', // static by default, opt-in SSR per page
});
```

Mark dynamic pages: `export const prerender = false;`

## 4) React Island Pattern

```astro
---
// pages/projects/[id].astro — static shell
import BaseLayout from '@/layouts/BaseLayout.astro';
import PipelineStream from '@/components/features/PipelineStream';

const { id } = Astro.params;
---
<BaseLayout title="Project">
  <!-- client:only skips SSR — needed for SSE hooks -->
  <PipelineStream projectId={id} client:only="react" />
</BaseLayout>
```

## 5) SSE Integration Pattern

```ts
// lib/useEventStream.ts
import { useEffect, useReducer } from 'react';

type PipelineEvent = {
  type: 'brief_normalised' | 'scripts_generated' | 'content_delivered';
  payload: Record<string, unknown>;
  timestamp: string;
};

export function useEventStream(projectId: string) {
  const [events, dispatch] = useReducer(
    (state: PipelineEvent[], action: PipelineEvent) => [...state, action],
    []
  );

  useEffect(() => {
    const es = new EventSource(`/api/v1/projects/${projectId}/stream`);
    es.onmessage = (e) => dispatch(JSON.parse(e.data));
    return () => es.close();
  }, [projectId]);

  return events;
}
```

## 6) Performance Rules

- Layout, header, sidebar, nav: pure Astro — zero JS
- Forms: `client:load` — user expects immediate interaction
- Data-heavy lists: `client:visible` — only hydrate when scrolled into view
- Real-time/SSE components: `client:only="react"` — no SSR for event-driven state
- Image optimization: use Astro's `<Image />` component from `astro:assets`
- Font loading: `font-display: swap` + preload critical fonts in `<head>`

## 7) Build Checklist

- [ ] No hydration in layout shell (Sidebar, Header, Nav)
- [ ] All interactive islands have explicit `client:*` directive
- [ ] `useReducedMotion` respected in all animated islands
- [ ] `focus-visible` states present on all interactive controls
- [ ] SSE connection cleans up on component unmount (`es.close()` in cleanup)
- [ ] TypeScript strict mode passing (`astro check`)
- [ ] Mobile layout tested at 375px, 768px, 1280px

## 8) Integration Stack

| Layer | Tool |
|---|---|
| Framework | Astro 4.x (hybrid output) |
| UI components | React 18 islands |
| Styling | Tailwind CSS v3 + CSS variables |
| Primitives | shadcn/ui pattern (composable, token-driven) |
| Animation | Framer Motion (selective, reduced-motion aware) |
| Icons | lucide-react |
| Type safety | TypeScript strict mode |
| Real-time | EventSource (SSE) via `useEventStream` hook |
