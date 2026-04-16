---
name: state-management
description: Frontend single source of truth — server state with TanStack Query (caching, invalidation, optimistic updates), client state with Zustand (slices, middleware, persistence), URL as state, Redux Toolkit for coordinated entity state, and the discipline of never duplicating remote data in local stores
keywords: ["state", "management", "frontend", "tanstack", "query", "zustand", "url", "redux", "toolkit", "single", "source", "truth", "server", "caching", "invalidation", "optimistic", "updates", "client", "slices"]
orb_class: trojan
---

# state-management

**Core principle**: server state and client state are different problems. Conflating them is the root cause of most frontend data bugs.

- **Server state**: data that lives on the server. You don't own it — you cache it. TanStack Query or SWR.
- **Client state**: data that only exists in the browser. You do own it. Zustand or Jotai.
- **URL state**: filters, pagination, selected IDs. The URL is the store — `nuqs` or `useSearchParams`.

If you put server data into a Zustand store, you are building a second cache on top of TanStack Query. You will invent your own invalidation logic and lose.

## 1) TanStack Query — server state authority

```typescript
// lib/query-client.ts — one instance, shared everywhere
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,       // data fresh for 1 min — don't refetch on every focus
      retry: 2,
      refetchOnWindowFocus: false, // usually too aggressive for dashboards
    },
  },
});
```

```typescript
// hooks/use-articles.ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client";   // generated from OpenAPI spec (schema-authority)

// ── Query keys: treat them as addresses, not strings ─────────────────────────
export const articleKeys = {
  all:    ()               => ["articles"]              as const,
  list:   (filters: object)=> ["articles", "list", filters] as const,
  detail: (slug: string)   => ["articles", "detail", slug]  as const,
};

// ── Read ──────────────────────────────────────────────────────────────────────
export function useArticles(filters: ArticleFilters) {
  return useQuery({
    queryKey: articleKeys.list(filters),
    queryFn:  () => api.getArticles(filters),
  });
}

export function useArticle(slug: string) {
  return useQuery({
    queryKey: articleKeys.detail(slug),
    queryFn:  () => api.getArticle(slug),
    enabled:  !!slug,
  });
}
```

## 2) Mutations with optimistic updates

```typescript
// hooks/use-publish-article.ts
export function usePublishArticle() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (slug: string) => api.publishArticle(slug),

    // ── Optimistic: update UI before server responds ─────────────────────────
    onMutate: async (slug) => {
      await qc.cancelQueries({ queryKey: articleKeys.detail(slug) });
      const previous = qc.getQueryData(articleKeys.detail(slug));

      qc.setQueryData(articleKeys.detail(slug), (old: Article) => ({
        ...old,
        status: "published",
      }));

      return { previous, slug };   // context passed to onError
    },

    // ── Roll back on error ───────────────────────────────────────────────────
    onError: (_err, _slug, ctx) => {
      if (ctx?.previous) {
        qc.setQueryData(articleKeys.detail(ctx.slug), ctx.previous);
      }
    },

    // ── Always invalidate: server is truth, cache is stale after mutation ────
    onSettled: (_data, _err, slug) => {
      qc.invalidateQueries({ queryKey: articleKeys.detail(slug) });
      qc.invalidateQueries({ queryKey: articleKeys.all() });
    },
  });
}
```

## 3) Zustand — client state only

```typescript
// store/ui-store.ts
// Only state that does NOT exist on the server belongs here.
import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

interface SidebarSlice {
  collapsed: boolean;
  toggleSidebar: () => void;
}

interface EditorSlice {
  draftTitle: string;
  draftBody: string;
  setDraft: (patch: Partial<{ title: string; body: string }>) => void;
  clearDraft: () => void;
}

// Slice pattern: keep each concern isolated
const createSidebarSlice = (set: any): SidebarSlice => ({
  collapsed: false,
  toggleSidebar: () => set((s: any) => ({ collapsed: !s.collapsed }), false, "toggleSidebar"),
});

const createEditorSlice = (set: any): EditorSlice => ({
  draftTitle: "",
  draftBody:  "",
  setDraft:   (patch) => set((s: any) => ({
    draftTitle: patch.title ?? s.draftTitle,
    draftBody:  patch.body  ?? s.draftBody,
  }), false, "setDraft"),
  clearDraft: () => set({ draftTitle: "", draftBody: "" }, false, "clearDraft"),
});

export const useUIStore = create<SidebarSlice & EditorSlice>()(
  devtools(
    persist(
      (...a) => ({
        ...createSidebarSlice(...a),
        ...createEditorSlice(...a),
      }),
      {
        name: "ui-store",
        partialize: (s) => ({ collapsed: s.collapsed }),  // only persist sidebar state
      }
    ),
    { name: "UIStore" }
  )
);
```

Derived selectors — compute outside the store, memoize at the component level:

```typescript
// Selector: derive from store without storing derived values
const draftLength = useUIStore((s) => s.draftBody.length);
const isDirty     = useUIStore((s) => s.draftTitle !== "" || s.draftBody !== "");
```

## 4) URL as state — filters, pagination, selection

When state should survive refresh and be shareable via link, the URL is the store.

```typescript
// app/articles/page.tsx  (Next.js App Router)
"use client";
import { useQueryState, parseAsInteger, parseAsStringEnum } from "nuqs";

const STATUS_VALUES = ["draft", "published", "archived"] as const;

export function ArticleListPage() {
  const [page,   setPage]   = useQueryState("page",   parseAsInteger.withDefault(1));
  const [status, setStatus] = useQueryState("status", parseAsStringEnum(STATUS_VALUES));
  const [search, setSearch] = useQueryState("q");

  const { data } = useArticles({ page, status: status ?? undefined, q: search ?? "" });

  return (
    <>
      <SearchInput value={search ?? ""} onChange={setSearch} />
      <StatusFilter value={status} onChange={setStatus} />
      <ArticleTable data={data} />
      <Pagination page={page} onPageChange={setPage} />
    </>
  );
}
// URL: /articles?page=2&status=published&q=react
// Refresh: same view. Share link: recipient sees same view. Back button: works.
```

Do not copy URL params into Zustand. The URL already IS the store.

## 5) Redux Toolkit — when Zustand isn't enough

Use RTK when you have:
- Complex normalized entity graphs (many-to-many, relational updates)
- Coordinated multi-step workflows where multiple slices must update atomically
- RTK Query replaces TanStack Query in teams already committed to Redux

```typescript
// store/articles-slice.ts
import { createSlice, createEntityAdapter, PayloadAction } from "@reduxjs/toolkit";

const adapter = createEntityAdapter<Article>({ selectId: (a) => a.slug });

const articlesSlice = createSlice({
  name: "articles",
  initialState: adapter.getInitialState({ selectedSlug: null as string | null }),
  reducers: {
    upsertArticles: adapter.upsertMany,
    selectArticle:  (state, action: PayloadAction<string>) => {
      state.selectedSlug = action.payload;
    },
    clearSelection: (state) => { state.selectedSlug = null; },
  },
});

export const { selectAll, selectById } = adapter.getSelectors(
  (state: RootState) => state.articles
);
```

RTK Query as server state layer (when already on RTK):

```typescript
// store/api-slice.ts
import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";

export const contentApi = createApi({
  reducerPath: "contentApi",
  baseQuery: fetchBaseQuery({ baseUrl: "/api" }),
  tagTypes: ["Article"],
  endpoints: (build) => ({
    getArticle: build.query<Article, string>({
      query: (slug) => `/articles/${slug}`,
      providesTags: (_r, _e, slug) => [{ type: "Article", id: slug }],
    }),
    publishArticle: build.mutation<Article, string>({
      query: (slug) => ({ url: `/articles/${slug}/publish`, method: "POST" }),
      invalidatesTags: (_r, _e, slug) => [{ type: "Article", id: slug }, "Article"],
    }),
  }),
});
```

## 6) Jotai — when component-tree state needs to be shareable

Jotai atoms are the right tool when state is more granular than a slice but needs to cross component boundaries without prop-drilling.

```typescript
// atoms/editor.ts
import { atom, atomWithStorage } from "jotai";
import { atomWithReset } from "jotai/utils";

export const draftTitleAtom = atomWithReset("");
export const draftBodyAtom  = atomWithReset("");
export const editorModeAtom = atom<"write" | "preview">("write");
// atomWithStorage: persists to localStorage automatically
export const sidebarAtom    = atomWithStorage("sidebar-collapsed", false);

// Derived atom — computed, not stored
export const wordCountAtom  = atom((get) => get(draftBodyAtom).split(/\s+/).filter(Boolean).length);
```

Use Jotai over Zustand when: atoms map 1:1 to UI concerns (one atom per form field, one atom per panel open/closed), and you don't need cross-cutting middleware like devtools or persistence across many atoms at once.

## 7) The decision tree

```
Is this data from the server?
  YES → TanStack Query (or RTK Query if you're on Redux)
        Never put it in Zustand. Never.
  NO  → Does it need to survive a page refresh / be shareable via URL?
          YES → URL (nuqs / useSearchParams)
          NO  → Is it scoped to one component subtree?
                  YES → useState or Jotai atom
                  NO  → Does it involve complex relational updates or many slices?
                          YES → Redux Toolkit + entity adapter
                          NO  → Zustand slice
```

## 8) Patterns to avoid

**Double-caching server data**
```typescript
// ✗ Wrong: copies server truth into a local store
const useArticleStore = create(() => ({
  articles: [] as Article[],
  fetchArticles: async () => { /* re-implement caching, invalidation, dedup */ }
}));

// ✓ Right: TanStack Query IS the store for server data
const { data: articles } = useArticles(filters);
```

**Derived state stored instead of computed**
```typescript
// ✗ Wrong: stores something you can compute
const [isPublished, setIsPublished] = useState(article.status === "published");

// ✓ Right: derive at render time
const isPublished = article.status === "published";
```

**Global store for form state**
```typescript
// ✗ Wrong: form state doesn't need to be global
useUIStore.setState({ formTitle: "..." });

// ✓ Right: react-hook-form owns form state locally
const { register, handleSubmit } = useForm<ArticleCreate>();
```

## 9) Checklist

- [ ] Server data is in TanStack Query — no manual fetch/store in Zustand for remote data
- [ ] Query keys use the factory pattern (`articleKeys.detail(slug)`) — no string literals
- [ ] Mutations always call `invalidateQueries` in `onSettled` — server is truth after mutation
- [ ] Optimistic updates always have an `onError` rollback
- [ ] Filter/pagination state is in the URL — survives refresh and shares correctly
- [ ] Zustand slices use `devtools` middleware in development
- [ ] Only non-server, non-URL state is in Zustand (UI toggles, drafts, selections)
- [ ] Derived values are computed at render time, not stored
- [ ] No duplicate field definitions between Zustand store and TanStack Query cache
