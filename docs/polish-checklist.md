# Polish verification checklist

## Plan (this pass)
See `docs/polish-plan.md`.

## Automated

```powershell
cd server
npm run smoke          # /api/ready + /api/health

cd ../client
npm run lint
npm run build
```

From repo root:

```powershell
npm run build
npm run smoke
```

## Manual (keep existing features)

- [ ] Open http://127.0.0.1:5173 — Landing loads
- [ ] Register / Login works
- [ ] Feed posts, like, comment
- [ ] Q&A ask + answer
- [ ] Settings (theme, account, password)
- [ ] Profile edit first/middle/last name
- [ ] Skip link: Tab once on feed → “Skip to main content”
- [ ] Page title changes per route (e.g. `Feed · Nexora`)
- [ ] Admin (if role=admin)
- [ ] Subscriptions mock subscribe still works without global Razorpay script
- [ ] Image upload uses Supabase when `USE_SUPABASE_STORAGE=true`

## Security / ops

- [ ] `server/.env` not committed
- [ ] Inactive user cannot use JWT (403)
- [ ] Health shows storage + email flags as expected

## Not in this pass (OK)

- Full TypeScript
- Playwright E2E
- Live Razorpay keys
- Custom domain
