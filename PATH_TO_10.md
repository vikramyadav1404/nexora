# Nexora — Path to production (10/10 checklist)

## Implemented in codebase (this upgrade)

| Area | What shipped |
|------|----------------|
| Security headers | `helmet` |
| Rate limits | API / auth / sensitive / write limiters |
| Input validation | email, password, sanitization helpers |
| Email verify | register OTP + Settings resend/verify |
| Delete account | `DELETE /api/auth/account` + Settings UI |
| Inactive ban | login blocked if `is_active=false` |
| Admin | `/api/admin/*` + `/admin` UI (role=admin) |
| Reports workflow | open → reviewing → resolved / dismissed |
| Cloud storage hook | `USE_SUPABASE_STORAGE=true` + `utils/storage.js` |
| Health | `/api/health` extras + `/api/ready` for uptime |
| Legal | `/terms`, `/privacy` |
| SQL extras | `server/db/migration_production.sql` |

## You still configure in the real world

1. **Run SQL** (optional but recommended)  
   Supabase SQL Editor → paste `server/db/migration_production.sql` → Run

2. **Real email** in `server/.env`  
   ```env
   EMAIL_USER=your@gmail.com
   EMAIL_PASS=your_app_password
   ```

3. **Cloud media** (production deploys)  
   ```env
   USE_SUPABASE_STORAGE=true
   ```  
   Create public buckets `avatars` and `posts` in Supabase Storage (or let service_role create them).

4. **Make an admin**  
   In Supabase Table Editor → `users` → set your user `role` = `admin`

5. **Strong secrets**  
   ```env
   JWT_SECRET=<long random string>
   DEMO_MODE=false
   ```

6. **Payments**  
   Real `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` + webhook URL on host

7. **Deploy**  
   - API: Render/Railway with env vars  
   - Client: Vercel with `VITE_API_URL=https://your-api`  
   - Point uptime monitor at `https://your-api/api/ready`

8. **Domain + HTTPS**  
   Custom domain on frontend and API

## Honest rating after this upgrade

**Code/product maturity ~ 8–8.5 / 10** when env + email + deploy + admin are live.  
A true **10/10** still needs: real user traffic hardening, full test suite, continuous monitoring, polished payments, and ops discipline over time.

## Quick test (local)

```bash
# server
cd server && npm run verify:supabase && node index.js

# client
cd client && npx vite --host 127.0.0.1 --port 5173
```

1. Register → note OTP toast in dev  
2. Settings → Account → Verify email  
3. Settings → About → Check backend (should say Supabase)  
4. Promote role to admin → open `/admin`
