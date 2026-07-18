# Turn Nexora into a phone app

You have **3 realistic options**. Start with **Option A** (easiest).

---

## Option A — PWA (recommended first) ✅ already partly done

Install the website on the phone like an app (home screen icon, fullscreen).

### What you need
1. App hosted on **HTTPS** (required for install on most phones)
2. Backend API reachable from the phone (not only `localhost`)

### Local test (same Wi‑Fi)
1. Find your PC IP, e.g. `192.168.1.10`
2. Run frontend with network access:

```bash
cd client
npx vite --host
```

3. On phone browser open: `http://YOUR_PC_IP:5173`  
4. Backend must allow that origin — set in `server/.env`:

```env
CLIENT_URL=http://YOUR_PC_IP:5173
```

And restart the server. Vite proxy only works for same-origin; for phone you may need the client to call the API host.  
**Easier path:** deploy both frontend + backend (see Option A deploy below).

### Install on Android (Chrome)
1. Open the live site  
2. Menu **⋮** → **Install app** / **Add to Home screen**  
3. Open from home screen → looks like an app  

### Install on iPhone (Safari)
1. Open the site in **Safari**  
2. Share → **Add to Home Screen**  
3. Open the icon  

### Deploy (so anyone can install)
| Piece | Easy hosts |
|--------|------------|
| Frontend (`client`) | Vercel, Netlify, Cloudflare Pages |
| Backend (`server`) | Railway, Render, Fly.io |
| Database | Supabase |

Then open the public URL on the phone and install as PWA.

---

## Option B — Capacitor (real Android/iOS app package)

Wraps your **same React app** in a native shell → Play Store / TestFlight possible.

### Steps (high level)

```bash
cd client
npm install @capacitor/core @capacitor/cli @capacitor/android
# optional: @capacitor/ios (needs Mac)
npx cap init Nexora com.nexora.app --web-dir dist
npm run build
npx cap add android
npx cap sync
npx cap open android
```

In Android Studio: run on emulator or USB phone.

### Important
- Set API base URL to your **deployed** backend (not localhost)
- HTTPS recommended  
- Camera/file uploads may need Capacitor plugins  

**Effort:** medium. **Impressive:** yes for “we have an APK”.

---

## Option C — React Native / Flutter rewrite

Build a separate native UI.  
**Not recommended** to “convert” this project — it’s a full rebuild.

---

## What we added for easier phone use

- **Bottom tab bar** on small screens (Home, Spaces, Q&A, Alerts, Me)
- **PWA manifest** + install meta tags  
- **Service worker** for basic offline shell  

---

## Practical recommendation

| Goal | Do this |
|------|---------|
| Use on your phone this week | Deploy or `--host` + PWA install |
| Share with friends | Deploy + PWA |
| Play Store later | Capacitor after deploy works |
| “Native only” app | Rewrite (expensive) |

**Best order:**  
1) Make UI mobile-friendly (done: bottom nav)  
2) Deploy frontend + backend + Supabase  
3) Install as PWA on phones  
4) Optional: Capacitor for store listing  

---

## Checklist before phone testing

- [ ] Backend not only on `localhost` (deploy or LAN IP)  
- [ ] `CLIENT_URL` matches how the phone opens the app  
- [ ] CORS allows your frontend origin  
- [ ] Supabase or demo mode works from network  
- [ ] Test login + feed on real phone browser  
- [ ] Add to Home Screen  

---

## Quick “same Wi‑Fi” tip

If API calls fail on phone when using Vite:

In `client` create env for build:

```env
# client/.env.production
VITE_API_URL=https://your-api.onrender.com
```

Then in axios setup (AuthContext / main), use:

```js
axios.defaults.baseURL = import.meta.env.VITE_API_URL || '';
```

(Only needed when frontend and API are on different domains.)
