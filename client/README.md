# Nexora — client

React 19 SPA built with Vite. See the [root README](../README.md) for the full project.

```bash
npm install
npm run dev      # http://127.0.0.1:5173, proxies /api to :5000
npm run check    # oxlint + production build
```

## Layout

```
src/
  components/ui/   Avatar, Sheet, Lightbox, SmartImage, Skeleton…
  contexts/        AuthContext — the single source of session truth
  hooks/           useInfiniteScroll, useOptimistic, usePullToRefresh…
  pages/           22 route components, all React.lazy code-split
  services/        api.js (axios + JWT interceptor), realtime.js
  styles/          index.css (tokens + components), primitives.css
```

## Notes

**No CSS framework.** The design system is hand-written CSS driven by custom properties.
Light/dark theming switches on a `data-theme` attribute, resolved by an inline script in
`index.html` **before first paint** — doing it in a React effect flashed white on every
cold load for dark-mode users.

**Every route past login is lazy-loaded.** `App.jsx` is the only eager bundle.

**Auth token** lives in `localStorage` as `nexora_token`. A 401 from any request clears it
and dispatches a `nexora:logout` event that `AuthContext` listens for.

## Environment

Copy `.env.example` → `.env`:

- `VITE_API_URL` — API origin (omit in dev; Vite proxies instead)
- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — optional, enables Realtime notifications

Never put `SUPABASE_SERVICE_ROLE_KEY` here. The client gets the `anon` key only.
