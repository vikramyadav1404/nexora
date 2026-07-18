# Nexora — Community Platform

Full-stack social + Q&A platform.

| Layer | Stack |
|--------|--------|
| Frontend | React + Vite |
| Backend | Node.js + Express + JWT |
| Database | **Supabase Postgres** (real) |
| Payments | Razorpay (optional; mock if unset) |
| Email | Nodemailer / Gmail (optional; console mock if unset) |

```text
React  →  Express (JWT, business rules)  →  Supabase Postgres
```

---

## Quick start (real backend)

### 1. Prerequisites
- Node.js 18+
- Free [Supabase](https://supabase.com) project

### 2. Database schema
1. Open Supabase → **SQL Editor** → New query  
2. Paste **all** of `server/db/setup_step_a.sql`  
3. Run it  

Tables created include: `users`, `posts`, `questions`, `answers`, `friendships`, `follows`, `notifications`, `bookmarks`, `blocks`, `reports`, `transactions`, `point_transfers`, …

### 3. Environment
```bash
cd server
copy .env.example .env
```

Edit `server/.env`:
```env
DEMO_MODE=false
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...   # service_role secret (NOT anon)
JWT_SECRET=a_long_random_string
CLIENT_URL=http://localhost:5173
```

### 4. Install & verify
```bash
# from project root
npm install
cd server && npm install
cd ../client && npm install

cd ../server
npm run verify:supabase
```

### 5. Run
```bash
# project root — both servers
npm run dev
```

Or double-click `start.bat` on Windows.

| URL | Purpose |
|-----|---------|
| http://localhost:5173 | App |
| http://localhost:5000/api/health | API health (`db: "supabase"`) |

### 6. Smoke test
1. Register a **new** account (not demo@)  
2. Complete onboarding (interests)  
3. Supabase → Table Editor → `users` shows your row  
4. Restart the API — data is still there  

---

## Demo mode (optional fallback)

If Supabase keys are missing, the API falls back to **in-memory demo**:

```env
DEMO_MODE=true
```

- Login: `demo@nexora.com` / `demo1234`  
- Data is lost when the server restarts  

---

## Features

| Area | Endpoints |
|------|-----------|
| Auth | Register, login, me, forgot/change password |
| Feed | Posts, likes, comments, share, media upload |
| Social | Friends, follows, suggestions, onboarding interests |
| Q&A | Questions, answers, votes, accept answer |
| Rewards | Leaderboard, point transfers |
| Plans | Subscription plans + Razorpay (or mock) |
| Product | Notifications, bookmarks, search, spaces, challenges, digests, AI drafts, block/report |

---

## Project layout

```text
nexora-clean/
  client/           React app
  server/
    db/
      setup_step_a.sql   ← run once in Supabase
      features.js        streaks / notifications helpers
      supabase.js
      verifyStepA.js
    routes/              real Supabase routes
    index.js
  start.bat
  STEP_A_SUPABASE.md
```

---

## Production notes

1. Set strong `JWT_SECRET`  
2. Use real Razorpay + email only when ready  
3. Never put `service_role` in the React app  
4. Deploy API + set `CLIENT_URL` and `VITE_API_URL`  

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Still DEMO MODE | Real keys + `DEMO_MODE=false` + restart |
| `relation "users" does not exist` | Run `setup_step_a.sql` |
| `column "gender" does not exist` | Re-run full `setup_step_a.sql` |
| Invalid API key | Use **service_role**, not anon |
| CORS errors | Set `CLIENT_URL` to your frontend origin |
| Upload fails | Ensure `server/uploads` is writable |

Full Supabase guide: [`server/SUPABASE_SETUP.md`](server/SUPABASE_SETUP.md) · [`STEP_A_SUPABASE.md`](STEP_A_SUPABASE.md)
