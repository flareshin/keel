# React performance — writing reference

Distilled from Vercel `react-best-practices` (MIT; upstream `vercel-labs/agent-skills`, `skills/react-best-practices/rules/<id>.md`, read at `063bee9`). All 70 upstream rules, one bullet each (two ids share a bullet where upstream splits one idea), in upstream order of impact; the id in parentheses names the upstream file with the full before/after example. Stack-specific deltas (which rules a given codebase already satisfies by config, incident evidence, local helpers) live in that project's own skill, not here.

Read before writing data loading, large lists or grids, heavy components, or anything on the server side of Next.js. These are writing rules; a review blocks only on the items its own lenses name.

Three items overlap `/readable-code` K5.9 (derive values during render, `useEffect` only for external sync, interaction logic in handlers); K5.9 is the rule, the bullets below are the performance reading of it.

## 1. Round trips (CRITICAL)

- **Independent awaits run together** (`async-parallel`): two or more awaits whose inputs do not depend on each other go in one `Promise.all`. **Not when order is the contract**: printing, sequential writes, anything where a partial failure must stop the rest stays sequential.
- **Partial dependencies start each task as early as its inputs allow** (`async-dependencies`): when B needs A but C does not, C must not wait for A (`better-all`, or hand-built promise chains).
- **Start promises early, await late in API routes and server actions** (`async-api-routes`): kick off independent work before the first `await`.
- **Await only on the branch that uses it** (`async-defer-await`): an early return must not wait on a fetch it never reads.
- **Cheap sync condition before the async flag** (`async-cheap-condition-before-await`): in `await flag && localCondition`, test the local condition first so the remote call is skipped when it cannot matter.
- **Suspense boundaries instead of awaiting in the wrapper** (`async-suspense-boundaries`): the frame paints while the data streams.

## 2. Bundle (CRITICAL)

- **No barrel imports from large libraries** (`bundle-barrel-imports`): import from the source file, or configure `optimizePackageImports` / `modularizeImports` once so the bundler rewrites them; icon and component barrels cost 200–800 ms per cold start.
- **Statically analyzable import and file paths** (`bundle-analyzable-paths`): an explicit map or literal path, never a composed string, for `import()` and server file reads.
- **Heavy, not-first-paint components load lazily** (`bundle-dynamic-imports`): `next/dynamic` or `React.lazy` for editors, charts, PDF, canvas, maps.
- **Load a module when its feature turns on** (`bundle-conditional`): `import()` in the handler or the flag-gated effect for export, print, preview paths.
- **Analytics, logging and error tracking load after hydration** (`bundle-defer-third-party`).
- **Preload on intent** (`bundle-preload`): on hover or focus of the control that opens the heavy path.

## 3. Server side — Next.js RSC, SSR, route handlers (HIGH)

- **Authenticate inside every server action** (`server-auth-actions`): a `"use server"` function is a public endpoint; middleware and layout guards do not protect it.
- **Per-request dedup with `React.cache()`** (`server-cache-react`): auth and DB lookups called from several components run once per request.
- **Cross-request cache with an LRU** (`server-cache-lru`): `React.cache()` lives only one request.
- **Pass the same object reference to the client, not a transformed copy** (`server-dedup-props`): RSC serialization dedups by reference; sort and filter on the client.
- **Static I/O at module level** (`server-hoist-static-io`): fonts, logos, config read once per process, not per request.
- **No mutable module state for request data** (`server-no-shared-module-state`): renders run concurrently; module scope is process-wide memory.
- **Only the fields the client uses cross the RSC boundary** (`server-serialization`).
- **Compose components so sibling fetches run in parallel** (`server-parallel-fetching`): a child's fetch must not wait for the parent's.
- **Chain a dependent fetch inside each item's promise** (`server-parallel-nested-fetching`): one slow item must not block the rest.
- **Side work after the response with `after()`** (`server-after-nonblocking`): logging and analytics never delay the reply.

## 4. Client data fetching (MEDIUM-HIGH)

- **One request per data set, deduplicated across instances** (`client-swr-dedup`): SWR, TanStack Query, or the project's own cache; never one fetch per mounted component.
- **One global listener shared by N components** (`client-event-listeners`): a subscription hook, not a listener per instance.
- **Passive touch and wheel listeners** (`client-passive-event-listeners`): `{ passive: true }` unless the handler calls `preventDefault()`.
- **Versioned, minimal localStorage** (`client-localstorage-schema`): a version prefix on the key, only the fields needed, never sensitive data.

## 5. Re-renders (MEDIUM)

- **Never define a component inside a component** (`rerender-no-inline-components`): a new type every render remounts it, dropping state and focus.
- **Read dynamic state at the point of use** (`rerender-defer-reads`): do not subscribe to searchParams or storage for a value only read inside a callback.
- **Expensive subtrees become memoized components** (`rerender-memo`): the early return then skips the work.
- **Default non-primitive props of a memoized component are hoisted constants** (`rerender-memo-with-default-value`): an inline `[]` or `{}` default breaks `memo()`.
- **Primitive effect dependencies** (`rerender-dependencies`): `user.id`, not `user`.
- **Subscribe to the derived boolean, not the raw value** (`rerender-derived-state`): `isScrolled`, not `scrollY`.
- **Derive during render, never store what is computable** (`rerender-derived-state-no-effect`); reset on a prop change with `key`.
- **State from previous state uses the function form** (`rerender-functional-setstate`): `setRows(prev => …)` keeps callbacks stable and avoids stale closures.
- **Expensive initial state uses a lazy initializer** (`rerender-lazy-state-init`): `useState(() => build(rows))`.
- **No `useMemo` around a cheap primitive expression** (`rerender-simple-expression-in-memo`): the dependency compare costs more than the expression.
- **Independent computations get separate hooks** (`rerender-split-combined-hooks`): one `useMemo` with mixed dependencies reruns everything on any change.
- **A user action's side effect runs in the handler** (`rerender-move-effect-to-event`), not as state plus effect.
- **Frequent non-urgent updates are transitions** (`rerender-transitions`): `startTransition` around scroll- or drag-driven state.
- **Typing must not wait on heavy filtering** (`rerender-use-deferred-value`): filter from `useDeferredValue(query)`.
- **Transient values live in refs** (`rerender-use-ref-transient-values`): mouse positions, interval counters, in-flight flags; a ref update does not render.

## 6. Rendering (MEDIUM)

- **`&&` only with a boolean** (`rendering-conditional-render`): `{count > 0 && …}` or a ternary; `{count && …}` renders `0`.
- **`content-visibility: auto` on long lists** (`rendering-content-visibility`): off-screen rows are not laid out.
- **Static JSX hoisted outside the component** (`rendering-hoist-jsx`).
- **`<Activity>` for expensive show/hide** (`rendering-activity`): state and DOM survive the toggle.
- **`useTransition` instead of a manual loading flag** (`rendering-usetransition-loading`): `isPending` comes for free.
- **Resource hints for critical assets** (`rendering-resource-hints`): `preload`, `preconnect`, `prefetchDNS` from `react-dom`.
- **`defer` or `async` on every script tag** (`rendering-script-defer-async`).
- **Client-only storage-dependent content: inline script before hydration** (`rendering-hydration-no-flicker`): no SSR break, no post-hydration flicker.
- **Expected server/client mismatches get `suppressHydrationWarning`** (`rendering-hydration-suppress-warning`): dates, locale formatting, random ids only; never to hide a real bug.
- **Animate a wrapper `div`, not the SVG element** (`rendering-animate-svg-wrapper`): SVG animation is not hardware-accelerated in many browsers.
- **Reduced SVG coordinate precision** (`rendering-svg-precision`).

## 7. JavaScript hot paths (LOW-MEDIUM)

- **Length check before an expensive array comparison** (`js-length-check-first`).
- **Never sort state in place** (`js-tosorted-immutable`): `rows.toSorted(cmp)`; `.sort()` mutates props or state in place, so a sorted "copy" is the same reference and later reads see mutated data.
- **Repeated lookups use a Map or Set** (`js-index-maps`, `js-set-map-lookups`): build once outside the loop instead of `.find` or `.includes` per row.
- **No layout read between style writes** (`js-batch-dom-css`): batch class or `cssText` changes; a read in between forces a synchronous reflow.
- **Same inputs, same result: cache at module level** (`js-cache-function-results`).
- **Storage and cookie reads cached in memory** (`js-cache-storage`): they are synchronous I/O.
- **Property lookups cached in hot loops** (`js-cache-property-access`).
- **One loop instead of chained `.filter().map()`** (`js-combine-iterations`); **`flatMap` for map-and-filter** (`js-flatmap-filter`).
- **Return as soon as the answer is known** (`js-early-exit`).
- **RegExp hoisted out of render and loops** (`js-hoist-regexp`).
- **Min or max by a single pass, not a sort** (`js-min-max-loop`).
- **Non-critical work in `requestIdleCallback`** (`js-request-idle-callback`).

## 8. Advanced (LOW)

- **An Effect Event is never an effect dependency** (`advanced-effect-event-deps`): its identity changes every render by design.
- **Handlers used by long-lived subscriptions live in refs** (`advanced-event-handler-refs`): the subscription is not rebuilt when the callback changes.
- **App-wide init runs once per load, not per mount** (`advanced-init-once`): a module-level guard, not `useEffect([])`.
- **Latest values without re-running the effect** (`advanced-use-latest`): `useEffectEvent` or a `useLatest` ref.
