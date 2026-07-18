# Nexora go-live (v1)

## Live URLs

| Service | URL |
|---------|-----|
| **Website (frontend)** | https://client-olive-ten-89.vercel.app |
| **API (backend)** | https://nexora-api-beta.vercel.app |
| **API health** | https://nexora-api-beta.vercel.app/api/health |
| **API ready** | https://nexora-api-beta.vercel.app/api/ready |

## Wired configuration

- Frontend `VITE_API_URL` = `https://nexora-api-beta.vercel.app`
- Backend `CLIENT_URL` = `https://client-olive-ten-89.vercel.app`
- Also allows `*.vercel.app` origins for previews
- Supabase, storage, email env vars set on API project

## Smoke test (you)

1. Open https://client-olive-ten-89.vercel.app  
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
