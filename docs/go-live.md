# Nexora go-live (v1)

## Live URLs

| Service | URL |
|---------|-----|
| **Website (frontend)** | https://nexora.vikramyadav.me |
| **Website (old Vercel URL, still served)** | https://client-olive-ten-89.vercel.app |
| **API (backend)** | https://nexora-api-beta.vercel.app |
| **API health** | https://nexora-api-beta.vercel.app/api/health |
| **API ready** | https://nexora-api-beta.vercel.app/api/ready |

## Wired configuration

- Frontend `VITE_API_URL` is **unset**: the client calls `/api/*` on its own origin, and `client/vercel.json` rewrites that to the API. Setting it would make the API cross-site and break the `SameSite=Strict` refresh cookie.
- Backend `CLIENT_URL` = `https://client-olive-ten-89.vercel.app,https://nexora.vikramyadav.me`
- No wildcard origins. `*.vercel.app` was removed in the security audit; add a preview origin explicitly via `CORS_EXTRA_ORIGINS`.
- Supabase, storage, email env vars set on API project

## Smoke test (you)

1. Open https://nexora.vikramyadav.me  
2. Register a **new** account  
3. Complete onboarding  
4. Create a post  
5. Confirm row in Supabase Table Editor → `users` / `posts`

## Local still works

```text
http://127.0.0.1:5173  →  local API :5000
```

## Redeploy

```powershell
# API
cd server
vercel --prod --yes

# Frontend
cd ../client
vercel --prod --yes
```
