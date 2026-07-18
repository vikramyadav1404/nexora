# Real backend delivery (not demo)

## Architecture (final)

```text
Browser / PWA
    ↓  /api  (Vite proxy in dev, VITE_API_URL in prod)
Express (Node) — JWT, points, Razorpay, business rules
    ↓  service_role key
Supabase Postgres — all permanent data
```

## What is already built in code

| Module | Real Supabase routes |
|--------|----------------------|
| Auth | `routes/auth.js` |
| Posts | `routes/posts.js` (network = friends + follows) |
| Q&A | `routes/questions.js`, `answers.js` |
| Users / onboarding / follow | `routes/users.js` |
| Notifications | `routes/notifications.js` |
| Bookmarks | `routes/bookmarks.js` |
| Search | `routes/search.js` |
| Spaces | `routes/spaces.js` |
| Challenges | `routes/challenges.js` |
| Safety | `routes/safety.js` |
| AI drafts | `routes/ai.js` |
| Digests | `routes/digests.js` |
| Plans / rewards | `subscriptions.js`, `rewards.js` |

Demo (`routes/demo.js`) is **only** used when keys are missing or `DEMO_MODE=true`.

## Activate real backend (required — your account)

You must complete these steps on **your** machine (we cannot create your Supabase project):

### 1) SQL
Supabase → SQL Editor → run entire file:

`server/db/setup_step_a.sql`

### 2) `server/.env`

```env
DEMO_MODE=false
SUPABASE_URL=https://YOUR_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...service_role_secret...
JWT_SECRET=any_long_random_string
CLIENT_URL=http://127.0.0.1:5173
```

### 3) Verify

```bash
cd server
npm run verify:supabase
```

### 4) Start

Double-click `start-nexora.bat`  
or:

```bash
cd server && node index.js
cd client && npx vite --host 127.0.0.1 --port 5173
```

Server must print:

```text
✅ Connected to Supabase Postgres (all tables OK)
```

### 5) Use app for real
1. Open http://127.0.0.1:5173  
2. **Register** (not demo@)  
3. Complete interests onboarding (auto-follows hubs → you can post)  
4. Confirm rows in Supabase Table Editor  
5. Restart server → still logged in / data remains  

## Production deploy

See `V1_COMPLETE.md` section C (Render API + Vercel client).

```env
# client production
VITE_API_URL=https://your-api.onrender.com
```

## Done definition (real, not demo)

- [ ] Health: `"db":"supabase"`, `"realBackend":true`
- [ ] New users persist in Supabase
- [ ] Posts + questions persist after restart
- [ ] Notifications / search / spaces work against DB
- [ ] No reliance on demo@nexora.com for real users

Until Supabase keys are set, the app safely runs in **demo** so you can still develop UI.
