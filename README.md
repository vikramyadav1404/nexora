# Nexora

Social + Q&A app. React frontend, Express API, Supabase Postgres.

```text
Browser  →  Express (JWT)  →  Supabase
```

## Run it locally

1. Node 18+
2. A Supabase project
3. Run SQL once: `server/db/migrations/001_setup_step_a.sql`
4. Copy `server/.env.example` → `server/.env` and fill keys
5. Install and start:

```bash
npm run install-all
# terminal 1
cd server && npm start
# terminal 2
cd client && npm run dev
```

Open http://127.0.0.1:5173

Or double-click `start-nexora.bat` on Windows.

### Env that matter

```env
DEMO_MODE=false
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
JWT_SECRET=long-random-string
USE_SUPABASE_STORAGE=true
EMAIL_USER=...
EMAIL_PASS=...   # gmail app password
CLIENT_URL=http://127.0.0.1:5173
```

## Live (v1)

| | URL |
|--|-----|
| Site | https://client-olive-ten-89.vercel.app |
| API | https://nexora-api-beta.vercel.app |

See `docs/go-live.md`.

## Layout

```text
client/src/
  components/  contexts/  hooks/  pages/
  services/    styles/    utils/
server/
  db/migrations/  middleware/  routes/  scripts/  utils/
docs/
```

Naming notes: `docs/naming-conventions.md`

## Scripts

```bash
npm run dev           # api + client
npm run build         # client production build
npm run smoke         # hit /api/ready + /api/health
npm run verify:supabase
```

## Notes

- Don't put the service_role key in the frontend
- Payments are mock until real Razorpay keys are set
- Free Vercel cold starts can take a few seconds on first hit
