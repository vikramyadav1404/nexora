# Real Supabase backend setup

Turn Nexora from in-memory **demo** into **persistent Postgres** via Supabase.

```text
React → Express (JWT, rules) → Supabase Postgres
```

---

## Checklist

### 1. Create Supabase project
https://supabase.com → **New project**

### 2. Create tables
1. Supabase → **SQL Editor** → **New query**
2. Open **`server/db/migrations/001_setup_step_a.sql`**
3. Paste **all** of it → **Run**
4. Table Editor should show: `users`, `posts`, `questions`, `answers`, `notifications`, `bookmarks`, …

### 3. API keys
**Project Settings → API**
- **Project URL** → `SUPABASE_URL`
- **`service_role`** (secret) → `SUPABASE_SERVICE_ROLE_KEY`  
  ⚠️ Not the `anon` key. Never put service_role in the React app.

### 4. `server/.env`
```env
PORT=5000
DEMO_MODE=false

SUPABASE_URL=https://xxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...your_real_key

JWT_SECRET=nexora_super_secret_jwt_key_2024
CLIENT_URL=http://localhost:5173
```

### 5. Verify
```bash
cd server
npm run verify:supabase
```

Expected: all tables ✓ and `Database OK`.

### 6. Start
```bash
# root
npm run dev
```

Server must print:
```text
✅ Connected to Supabase Postgres (all tables OK)
🗄️  Database:     Supabase Postgres (real backend)
```

Not `DEMO MODE`.

### 7. Smoke test
1. http://localhost:5173 → **Register** a new account  
2. Supabase → **users** → new row  
3. Onboarding → feed posts appear  
4. Restart API → data remains  

---

## API surface (real mode)

| Area | Routes |
|------|--------|
| Auth | `/api/auth/*` |
| Posts | `/api/posts/*` |
| Q&A | `/api/questions/*`, `/api/answers/*` |
| Users | `/api/users/*` |
| Plans / rewards | `/api/subscriptions/*`, `/api/rewards/*` |
| Notifications | `/api/notifications/*` |
| Bookmarks | `/api/bookmarks` |
| Search | `/api/search` |
| Spaces | `/api/spaces/*` |
| Challenges | `/api/challenges/*` |
| Digests | `/api/digests/weekly` |
| AI drafts | `/api/ai/*` |
| Safety | `/api/blocks/*`, `/api/reports` |

---

## Common errors

| Problem | Fix |
|---------|-----|
| Still DEMO MODE | Real keys + `DEMO_MODE=false` + restart |
| Missing tables | Run `setup_step_a.sql` |
| Invalid API key | Use **service_role** |
| Login only works for demo@ | You are still in demo mode |

---

## Switch back to demo

```env
DEMO_MODE=true
```

Restart → `demo@nexora.com` / `demo1234`
