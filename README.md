# Nexora

A social + Q&A platform. Share posts with your network, ask questions, answer other people's, earn points, and climb a leaderboard — organised around interest communities called Spaces.

**Live:** [client-olive-ten-89.vercel.app](https://client-olive-ten-89.vercel.app) · **API:** [nexora-api-beta.vercel.app](https://nexora-api-beta.vercel.app/api/health)

```
Browser  →  React 19 (Vercel)  →  Express API (Vercel serverless)  →  Supabase Postgres
```

---

## What it does

**Social feed** — post text and images, like, comment, share, save. The feed is personalised: posts from people you follow and topics you've picked rank higher.

**Q&A** — ask a question, get answers from the community, upvote, accept the best one. Your daily question allowance depends on your subscription tier.

**Spaces** — 16 interest communities (technology, music, gaming, fitness…). Onboarding picks your interests, auto-follows the relevant hubs, and seeds your feed.

**Points & rewards** — earn points for answering, transfer them to other users, unlock badges, appear on the leaderboard.

**Subscriptions** — Bronze / Silver / Gold tiers via Razorpay, each raising your daily question limit.

**AI assists** (optional) — Claude drafts an answer, rewrites a vague question, suggests tags, and triages moderation reports.

**Safety** — block users, report content, admin moderation queue.

One deliberate product rule worth knowing: **you can't post until you have a network.** Zero connections means zero posts per day; 1 connection unlocks 1/day, 2–9 unlocks 2/day, 10+ is unlimited. It nudges new users to connect before they broadcast.

---

## Tech stack

### Frontend
| | |
|---|---|
| **React 19** | UI, with `React.lazy` code-splitting on every route |
| **Vite 8** | Build tool and dev server |
| **React Router 7** | Client-side routing |
| **Motion 12** | Animation — springs, gestures, route transitions |
| **Embla Carousel** | Swipeable multi-image posts |
| **Lucide** | Icons |
| **Inter Variable** | Self-hosted font, no external request |
| **Axios** | HTTP client with a JWT interceptor |

No CSS framework. The design system is ~2,100 lines of hand-written CSS driven by custom properties, with light/dark theming via `data-theme`.

### Backend
| | |
|---|---|
| **Node + Express 4** | REST API — 130 endpoints across 18 route modules |
| **Supabase Postgres** | Database, accessed via PostgREST |
| **JWT** | Stateless auth, 7-day tokens |
| **bcryptjs** | Password hashing, cost 12 |
| **Sharp** | Image resize, WebP conversion, EXIF stripping |
| **Multer** | Multipart uploads (memory storage — serverless-safe) |
| **Razorpay** | Payments |
| **Nodemailer** | Transactional email |
| **express-rate-limit** | Rate limiting, backed by Postgres |
| **Anthropic SDK** | Claude-powered writing assists |

### Infrastructure
- **Vercel** — two projects: static frontend, serverless API
- **Supabase** — Postgres + Storage buckets + Realtime
- **Vercel Cron** — daily maintenance, weekly digest
- **Vitest + Supertest** — 33 tests
- **GitHub Actions** — CI on every push

### By the numbers
`22` pages · `130` API endpoints · `20` database tables · `9` shared UI components · `8` custom hooks · `33` tests

---

## Architecture notes

Things that aren't obvious from the file tree:

**Auth is stateless but not stale.** There's no session store. Every protected request verifies the JWT *and* re-reads the user row, so a ban or role change takes effect on the very next request — no token revocation machinery needed.

**No ORM.** Routes call PostgREST directly through `getSupabase()`. The API uses the `service_role` key, which bypasses Row Level Security — meaning **Express is the only access-control layer.** Every route does its own authorisation in JavaScript.

**snake_case in, camelCase out.** Postgres columns are `snake_case`; the API contract is `camelCase`. The translation lives entirely in `server/db/helpers.js` (`shapeUser`, `shapePost`, `shapeQuestion`…). Every shaped object carries both `_id` and `id` — a compatibility hangover from a MongoDB-era client.

**The feed uses cursor pagination, not pages.** `GET /api/posts` returns an opaque `nextCursor` encoding `(created_at, id)`. Offset pagination would let a new post shift rows across page boundaries mid-scroll, producing duplicates and gaps.

**Demo mode is a complete second backend.** With `DEMO_MODE=true`, `server/routes/demo.js` replaces the entire `/api` surface with an in-memory store — same paths, same response shapes. The client can't tell the difference. Useful for running the app with no database at all.

**Features degrade rather than fail.** Missing `ANTHROPIC_API_KEY` → AI routes return 503 and the UI hides them. Missing search migrations → search falls back to `ILIKE`. Sharp unavailable → images store unoptimized. Nothing crashes because an optional key is absent.

---

## Project layout

```
client/
  src/
    components/ui/     Shared primitives (Avatar, Sheet, Lightbox, SmartImage…)
    contexts/          AuthContext — the single source of session truth
    hooks/             useInfiniteScroll, useOptimistic, usePullToRefresh…
    pages/             22 route components
    services/          axios instance, Supabase Realtime client
    styles/            index.css (tokens + components), primitives.css
server/
  db/
    migrations/        SQL files, run in order
    helpers.js         Row → API-shape translation
    demoStore.js       In-memory backend for DEMO_MODE
  middleware/          auth (JWT), admin, rateLimit
  routes/              18 modules, 130 endpoints
  utils/               claude, image, storage, email, respond, observability
  test/                Vitest suites
```

---

## Running locally

**Requires Node 18+**

```bash
git clone https://github.com/vikramyadav1404/nexora.git
cd nexora
npm run install-all
```

### Option A — no database (fastest)

```bash
cd server && DEMO_MODE=true npm start    # terminal 1
cd client && npm run dev                 # terminal 2
```

Open http://127.0.0.1:5173 and log in with `demo@nexora.com` / `demo1234`.

Everything works except persistence — data resets when the server restarts.

### Option B — real database

1. Create a project at [supabase.com](https://supabase.com)
2. Open **SQL Editor** and run `server/db/migrations/SETUP_ALL.sql` — creates all 20 tables, 10 functions, 21 indexes
3. Copy `server/.env.example` → `server/.env` and fill in:

```env
DEMO_MODE=false
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...     # secret — server only, never the client
JWT_SECRET=<long random string>
CLIENT_URL=http://127.0.0.1:5173
```

4. Run `npm run dev` from the root to start both.

---

## Environment variables

**Required** (server): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `CLIENT_URL`

**Optional** — each unlocks a feature, and the app runs fine without it:

| Variable | Unlocks |
|---|---|
| `ANTHROPIC_API_KEY` | AI answer drafting, question rewriting, auto-tagging, moderation triage |
| `SUPABASE_JWT_SECRET` | Live notification badge over Supabase Realtime |
| `RAZORPAY_KEY_ID` / `_SECRET` | Real payments (mock checkout without them) |
| `RAZORPAY_WEBHOOK_SECRET` | Recovers payments whose browser callback never lands |
| `CRON_SECRET` | Scheduled jobs |
| `SENTRY_DSN` | Error reporting |
| `USE_SUPABASE_STORAGE` | Cloud media storage instead of local disk |
| `EMAIL_USER` / `EMAIL_PASS` | Transactional email (Gmail app password) |

Client: `VITE_API_URL`, plus optionally `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` for Realtime.

> **Never** put `SUPABASE_SERVICE_ROLE_KEY` in `client/.env`. It bypasses all database security. The client gets the `anon` key only.

---

## Scripts

```bash
npm run dev              # api + client together
npm run build            # production client build

cd server
npm test                 # 33 Vitest tests
npm run backup           # dump every table to backups/*.json
npm run smoke            # hit /api/ready + /api/health

cd client
npm run lint             # oxlint
npm run check            # lint + build
```

---

## Testing

33 tests, no database required — the suite injects a fake Supabase client (`server/test/helpers/fakeSupabase.js`).

Coverage is deliberately weighted toward things that are expensive to get wrong:

- **Payment verification** — including a regression test that replays a real privilege-escalation attack and asserts it now fails
- **Points transfer under concurrency** — proves points can't be double-spent
- **Feed cursor pagination** — including the 60-post cap that used to truncate the feed
- **Search input escaping** — against PostgREST filter injection
- **Image pipeline** — resize caps, WebP conversion, corrupt-file handling

```bash
cd server && npm test
```

---

## Deployment

Two Vercel projects from one repo.

**API** (`server/`) — Node serverless. Set the env vars above in the Vercel dashboard. `server/vercel.json` registers two cron jobs.

**Frontend** (`client/`) — static build with SPA rewrite. Set `VITE_API_URL` to the deployed API origin.

```bash
cd server && vercel --prod
cd client && vercel --prod
```

**Keeping the database alive:** free Supabase projects pause after ~1 week of inactivity and are eventually deleted. The daily cron job (`/api/cron/daily`) touches the database and prevents this. `/api/cron/keepalive` is an unauthenticated health endpoint you can point an external uptime monitor at for redundancy.

---

## Security

Notable decisions, and one caveat:

- Passwords are bcrypt-hashed at cost 12; hashes never leave the server
- Payment verification derives the plan from the **stored transaction**, never the request body, and verifies the Razorpay HMAC in constant time
- Point transfers run inside a Postgres function with row locks, so concurrent requests can't double-spend
- User input is escaped before it reaches PostgREST filter strings
- Uploaded images have EXIF metadata stripped, removing GPS coordinates
- 500 responses return a generic message plus a request ID; the full error goes to the server log only
- Rate limits are stored in Postgres, so they survive serverless cold starts

**Caveat:** the API uses the `service_role` key, which bypasses Row Level Security. RLS is enabled on every table, but it is not the enforcement layer — Express is. Any new route must do its own authorisation.

---

## Status

Live and working. Some features ship dormant and switch on when their key is set — see the environment-variable table above.

Known gaps, honestly:

- **Video isn't transcoded.** Images are optimised; videos upload as-is, up to 50 MB.
- **No frontend tests.** The 33 tests cover the API only.
- **No direct messages.** The social graph supports friends and follows, but there's no messaging.

---

## License

MIT
