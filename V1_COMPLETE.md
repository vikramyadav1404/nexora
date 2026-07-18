# Nexora v1.0 — Finish line checklist

Ship criteria for calling this project **v1.0 complete**.

---

## A. Local product (can demo today)

- [x] Feed, Q&A, auth, interests, plans, rewards
- [x] Notifications, search, spaces, challenges, bookmarks
- [x] Mobile bottom nav + PWA basics + dark mode
- [x] Demo mode: `demo@nexora.com` / `demo1234`
- [x] Version **1.0.0** (Settings → About, `/api/version`, `/api/health`)

**Status: ready for local demo**

---

## B. Real backend (Supabase live) — *you must do this*

| # | Task | Done when |
|---|------|-----------|
| 1 | Create Supabase project | Project exists |
| 2 | Run `server/db/setup_step_a.sql` | Tables visible |
| 3 | Set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in `server/.env` | Real keys (not placeholders) |
| 4 | Set `DEMO_MODE=false` | |
| 5 | `cd server && npm run verify:supabase` | ✅ Step A database OK |
| 6 | `npm run dev` shows **Supabase Postgres** | Not DEMO MODE |
| 7 | Register new user → row in Table Editor | Data persists after restart |

Guide: **`STEP_A_SUPABASE.md`**

---

## C. Deploy (public URL)

### Backend (Render example)
1. Push repo to GitHub  
2. [render.com](https://render.com) → New Web Service → root `server`  
3. Start: `npm start`  
4. Env vars:
   - `DEMO_MODE=false`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `JWT_SECRET` (long random)
   - `CLIENT_URL=https://your-frontend.vercel.app`
5. Blueprint optional: `deploy/render.yaml`

### Frontend (Vercel example)
1. Import `client` folder / monorepo root with root `client`  
2. Build: `npm run build` · Output: `dist`  
3. Env: `VITE_API_URL=https://your-api.onrender.com`  
4. `vercel.json` already has SPA rewrites  

### After deploy
- [ ] Open public frontend URL  
- [ ] Register + login  
- [ ] Create post / question  
- [ ] Phone: Add to Home Screen (PWA)  

---

## D. v1.0 “complete” definition

| Layer | Complete when |
|-------|----------------|
| Features | Core community loops work |
| Data | Supabase, not only demo |
| Access | Live HTTPS URL |
| Mobile | Usable on phone (responsive + PWA) |
| Version | Shows 1.0.0 |

You can ship **v1.0** after **B + C**.  
Until then: **v1.0-demo** (local / demo mode).

---

## Quick commands

```bash
# Install
npm run install-all

# Local demo
cd server && npm run dev
cd client && npm run dev

# Verify Supabase
cd server && npm run verify:supabase
```

---

## What is intentionally NOT in v1.0

- Instagram Stories / live video  
- Play Store listing (use Capacitor later)  
- Full automated test suite  
- Real Razorpay live keys (mock OK for demo)  

---

**Next action for you:** finish section **B** (Supabase keys + SQL), then **C** (deploy).
