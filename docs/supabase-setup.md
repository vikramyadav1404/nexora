# Supabase + Express setup (Nexora)

Nexora keeps **Express + JWT + Razorpay** and uses **Supabase Postgres** as the database only (not Supabase Auth).

## 1. Create a Supabase project

1. Go to [https://supabase.com](https://supabase.com) → New project  
2. Note **Project URL** and keys under **Project Settings → API**

## 2. Run the SQL schema

1. Open **SQL Editor** → New query  
2. Paste the full contents of **`server/db/migrations/001_setup_step_a.sql`**  
3. Run it  

Includes: auth, posts, Q&A, friends, follows, transactions, notifications, bookmarks, blocks, reports.

Then verify:

```bash
cd server
npm run verify:supabase
```

## 3. Configure environment

Copy `server/.env.example` → `server/.env` and fill:

```env
DEMO_MODE=false
SUPABASE_URL=https://xxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...   # service_role (server only!)
JWT_SECRET=your_jwt_secret
CLIENT_URL=http://localhost:5173
```

**Important:** Use the **`service_role`** key on the server so Express can bypass RLS.  
Never put `service_role` in the React client.

## 4. Start the API

```bash
cd server
npm install
npm run dev
```

You should see:

```
✅ Connected to Supabase Postgres (all tables OK)
🚀 Nexora server running on http://localhost:5000
```

## 5. Verify health

```bash
curl http://localhost:5000/api/health
```

```json
{
  "status": "OK",
  "db": "supabase",
  "realBackend": true
}
```

Register a user from the frontend — it should appear under **Table Editor → users**.

## Architecture

```
React  →  Express (JWT, business rules)  →  Supabase Postgres
```

| Kept in Express | Stored in Supabase |
|-----------------|--------------------|
| Auth (register/login JWT) | Users, posts, friends |
| Friend post limits | Q&A, votes, transfers |
| Points / badges logic | Notifications, bookmarks |
| Razorpay + email | Transactions, reports |

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `Missing Supabase config` | Set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` |
| `relation "users" does not exist` | Run `setup_step_a.sql` |
| `Invalid API key` | Use **service_role**, not anon |
| Falls back to DEMO | Keys still placeholders or `DEMO_MODE=true` |
