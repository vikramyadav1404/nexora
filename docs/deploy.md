# Deploy Nexora (production)

**Stack:** Supabase (DB) · Render (API) · Vercel (frontend)

---

## Before you start

1. Supabase project works locally (`DEMO_MODE=false`, tables OK).
2. You have free accounts:
   - [GitHub](https://github.com)
   - [Render](https://render.com)
   - [Vercel](https://vercel.com)
3. **Never** commit `server/.env` (secrets stay on host dashboards).

---

## Step 1 — Put code on GitHub

### A. Create empty repo on GitHub
1. github.com → **New repository**
2. Name: `nexora` (or any name)
3. **Do not** add README if you already have local code
4. Create repository
5. Copy the repo URL, e.g. `https://github.com/YOUR_USER/nexora.git`

### B. On your PC (PowerShell)

```powershell
cd "C:\Users\dell\OneDrive\Desktop\PROJECT\nexora-clean"

git init
git add .
git status
# Confirm server/.env is NOT listed

git commit -m "Nexora production-ready deploy"
git branch -M main
git remote add origin https://github.com/YOUR_USER/nexora.git
git push -u origin main
```

Login to GitHub in the browser if Git asks.

---

## Step 2 — Deploy API on Render

1. [render.com](https://render.com) → **New** → **Web Service**
2. Connect **GitHub** → select `nexora` repo
3. Settings:

| Field | Value |
|--------|--------|
| **Root Directory** | `server` |
| **Runtime** | Node |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Instance** | Free (or paid) |

4. **Environment** → Add:

| Key | Value |
|-----|--------|
| `NODE_ENV` | `production` |
| `DEMO_MODE` | `false` |
| `SUPABASE_URL` | `https://YOUR_PROJECT_REF.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | *(your secret key from Supabase)* |
| `JWT_SECRET` | *(long random string, e.g. 40+ chars)* |
| `CLIENT_URL` | `https://your-app.vercel.app` *(set after Step 3; can update later)* |
| `USE_SUPABASE_STORAGE` | `true` *(recommended for prod images)* |
| `EMAIL_USER` | *(optional Gmail)* |
| `EMAIL_PASS` | *(optional app password)* |

5. **Create Web Service** → wait until status is **Live**
6. Copy API URL, e.g. `https://nexora-api-xxxx.onrender.com`

### Test API

Open in browser:

```text
https://YOUR-RENDER-URL/api/health
https://YOUR-RENDER-URL/api/ready
```

You want `"realBackend": true` and `"ready": true`.

> Free Render sleeps after idle ~15 min. First request may take 30–60s.

---

## Step 3 — Deploy frontend on Vercel

1. [vercel.com](https://vercel.com) → **Add New** → **Project**
2. Import the same GitHub `nexora` repo
3. Configure:

| Field | Value |
|--------|--------|
| **Root Directory** | `client` |
| **Framework** | Vite |
| **Build Command** | `npm run build` |
| **Output Directory** | `dist` |

4. **Environment Variables:**

| Key | Value |
|-----|--------|
| `VITE_API_URL` | `https://YOUR-RENDER-URL` *(no trailing slash)* |

Example: `https://nexora-api-xxxx.onrender.com`

5. **Deploy**
6. Copy frontend URL, e.g. `https://nexora-xxx.vercel.app`

---

## Step 4 — Connect CORS (important)

Back on **Render** → your API → Environment:

```text
CLIENT_URL=https://nexora-xxx.vercel.app
```

(If you have custom domain later, add it comma-separated.)

**Save** → service restarts.

---

## Step 5 — Supabase for production media (recommended)

1. Supabase → **Storage** → create buckets:
   - `avatars` (public)
   - `posts` (public)
2. Or run once after deploy with service_role; code can create buckets when `USE_SUPABASE_STORAGE=true`.
3. Optional SQL: `server/db/migrations/004_production.sql`

---

## Step 6 — Smoke test live app

1. Open Vercel URL  
2. **Register** new user  
3. Complete onboarding  
4. Create a post  
5. Supabase **Table Editor** → confirm `users` / `posts` rows  
6. Settings → Account → verify email (needs real `EMAIL_*` or use dev logs on server)

---

## Blueprint alternative (Render)

Repo includes `deploy/render.yaml`.  
Render → **New** → **Blueprint** → connect repo → apply `deploy/render.yaml`  
Still set secret env vars manually (`SUPABASE_*`, `CLIENT_URL`).

---

## Custom domain (optional)

| Service | Where |
|---------|--------|
| Frontend | Vercel → Domains |
| API | Render → Custom Domain |
| Then set `VITE_API_URL` + `CLIENT_URL` to those domains and redeploy |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Frontend calls localhost | `VITE_API_URL` missing → set + **redeploy** Vercel |
| CORS error | `CLIENT_URL` must match exact Vercel origin (https, no slash) |
| 503 / tables missing | Run `setup_step_a.sql` on Supabase |
| Demo mode on Render | `DEMO_MODE=false` + real service_role key |
| Images break after restart | Enable `USE_SUPABASE_STORAGE=true` |
| Cold start slow | Normal on free Render; upgrade or ping `/api/ready` |

---

## Security checklist

- [ ] `server/.env` never on GitHub  
- [ ] Service role key only on Render (not Vercel, not client)  
- [ ] Strong `JWT_SECRET` in production  
- [ ] `DEMO_MODE=false`  
- [ ] Make first admin: Supabase `users.role = admin`  

---

## Local vs production

| | Local | Production |
|--|--------|------------|
| API | `http://127.0.0.1:5000` | Render URL |
| Web | `http://127.0.0.1:5173` | Vercel URL |
| DB | Same Supabase project (or separate prod project) | Supabase |

Done when: **register on Vercel URL → row appears in Supabase**.
