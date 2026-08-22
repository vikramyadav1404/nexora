const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const { apiLimiter } = require('./middleware/rateLimit');
const { setMediaColumnSupport } = require('./db/helpers');
const { shouldUseDemoMode, mayPublishDemoLogin } = require('./utils/demoMode');
const { assertJwtSecret } = require('./utils/tokens');
const { isAllowedOrigin, allowedOrigins } = require('./utils/corsOrigins');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Behind Render/Vercel/nginx — correct IPs for rate limits
app.set('trust proxy', 1);

// Ensure upload dirs exist (local/dev; cloud uses Supabase Storage)
// On Vercel the filesystem is read-only except /tmp — never crash boot on mkdir
['uploads', 'uploads/posts', 'uploads/avatars'].forEach((dir) => {
  try {
    const full = path.join(__dirname, dir);
    if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
  } catch (e) {
    // ignore EROFS etc. on serverless
  }
});

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false
}));

app.use(compression());

/*
 * CORS — an exact allowlist, because this sends credentials.
 *
 * This used to allow any origin matching /\.vercel\.app$/i. Anyone can deploy
 * to attacker-xyz.vercel.app, so with `credentials: true` that let an arbitrary
 * site make credentialed cross-origin requests the browser would let it READ.
 * Verified against production before changing it: an unrelated .vercel.app
 * origin was echoed back in Access-Control-Allow-Origin.
 *
 * What limited the damage was accident, not design -- the access token travels
 * in an Authorization header rather than a cookie, and the refresh cookie is
 * SameSite=Strict scoped to /api/auth. Both are one refactor from changing, and
 * a rule this permissive should not be what stands behind them.
 *
 * localhost is now development-only. It was matched in production too, where no
 * legitimate localhost origin exists.
 *
 * CORS_EXTRA_ORIGINS is the escape hatch for preview deployments: explicit
 * origins someone typed out, rather than a pattern matching an entire hosting
 * platform.
 */
// Warn once per origin. Without this a CORS misconfiguration is invisible on
// the server and presents as an unexplained client bug.
const rejectedOrigins = new Set();

app.use(cors({
  origin: (origin, cb) => {
    // No Origin header: same-origin, curl, server-to-server. Not a CORS case.
    if (isAllowedOrigin(origin)) return cb(null, true);

    if (!rejectedOrigins.has(origin)) {
      rejectedOrigins.add(origin);
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'cors-rejected',
        origin,
        allowed: allowedOrigins(),
        hint: 'Add it to CLIENT_URL or CORS_EXTRA_ORIGINS if this is legitimate'
      }));
    }
    return cb(null, false);
  },
  credentials: true
}));

// Razorpay signs the exact request bytes, so the webhook needs the raw buffer.
// This MUST come before express.json(), which would re-serialize the body and
// change the bytes the HMAC is computed over.
app.use('/api/subscriptions/webhook', express.raw({ type: '*/*', limit: '1mb' }));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
// The refresh token arrives as an httpOnly cookie; Express 4 does not parse
// cookies on its own, so req.cookies is undefined without this.
app.use(require('cookie-parser')());

// One structured JSON line per request, carrying a request id that sendError
// reuses — so a user quoting an id can be traced to the exact failure.
const { requestLogger } = require('./utils/observability');
const { isDev, sendError } = require('./utils/respond');
app.use(requestLogger);
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag: true
}));
app.use('/api', apiLimiter);

const appVersion = require('./version');
/*
 * Identifies the running build in one request.
 *
 * This returned a static '1.0.0' for every deploy ever made, so answering
 * "what is in production" meant sending a request only the new code responds to
 * differently -- and that guessing was wrong twice. `commit` is null rather
 * than a placeholder when the deploy was not stamped: an unknown commit and a
 * known one must not read alike. `deploymentId` comes from the platform and is
 * correct even when the stamp is missing.
 */
app.get('/api/version', (req, res) => {
  res.json({
    ...appVersion,
    demoMode: null,
    env: process.env.NODE_ENV || 'development'
  });
});

const CORE_TABLES = [
  'users', 'posts', 'questions', 'answers',
  'notifications', 'bookmarks', 'blocks', 'reports',
  'friendships', 'follows', 'transactions', 'point_transfers'
];

async function checkSupabaseTables(db, tables = CORE_TABLES) {
  const status = {};
  for (const table of tables) {
    const { error } = await db.from(table).select('*', { count: 'exact', head: true }).limit(1);
    status[table] = error ? { ok: false, error: error.message } : { ok: true };
  }
  return status;
}

function mountRealRoutes(appInstance) {
  appInstance.use('/api/auth', require('./routes/auth'));
  appInstance.use('/api/posts', require('./routes/posts'));
  appInstance.use('/api/questions', require('./routes/questions'));
  appInstance.use('/api/answers', require('./routes/answers'));
  appInstance.use('/api/subscriptions', require('./routes/subscriptions'));
  appInstance.use('/api/rewards', require('./routes/rewards'));
  appInstance.use('/api/users', require('./routes/users'));
  appInstance.use('/api/uploads', require('./routes/uploads'));
  // Authorising redirect for stored media. Buckets are private; this is the
  // only way an <img> gets at them. See routes/media.js.
  appInstance.use('/api/media', require('./routes/media'));
  appInstance.use('/api/notifications', require('./routes/notifications'));
  appInstance.use('/api/bookmarks', require('./routes/bookmarks'));
  appInstance.use('/api/search', require('./routes/search'));
  appInstance.use('/api/spaces', require('./routes/spaces'));
  appInstance.use('/api/challenges', require('./routes/challenges'));
  appInstance.use('/api/ai', require('./routes/ai'));
  appInstance.use('/api/digests', require('./routes/digests'));
  appInstance.use('/api', require('./routes/safety'));
  appInstance.use('/api/admin', require('./routes/admin'));
  // Vercel Cron targets; authenticated by CRON_SECRET, not a user session.
  appInstance.use('/api/cron', require('./routes/cron'));
}

let bootPromise = null;

/**
 * Initialize routes once (local listen or serverless).
 * @param {{ listen?: boolean }} opts
 */
async function startServer(opts = {}) {
  const shouldListen = opts.listen !== false;

  process.on('uncaughtException', (err) => {
    console.error('uncaughtException:', err.message);
  });
  process.on('unhandledRejection', (err) => {
    console.error('unhandledRejection:', err?.message || err);
  });

  if (!process.env.PUBLIC_API_URL && process.env.RENDER_EXTERNAL_URL) {
    process.env.PUBLIC_API_URL = process.env.RENDER_EXTERNAL_URL;
  }

  /*
   * VERCEL_URL is deliberately NOT used to derive PUBLIC_API_URL.
   *
   * It is the per-deployment immutable hostname -- a different value on every
   * deploy, and never the alias anything else refers to. Deriving a *public*
   * URL from it produced the avatar outage: publicAssetUrl prepended it to the
   * relative /api/media/... paths migration 017 had just created, so every
   * avatar and cover was served as an absolute cross-origin URL. The
   * nexora_media cookie is host-scoped to the client domain, an <img> cannot
   * send it cross-origin, and every image 401'd.
   *
   * Set PUBLIC_API_URL explicitly if something genuinely needs an absolute API
   * URL, and set it to the stable alias.
   */

  /*
   * Before anything else. A server that cannot sign a session correctly should
   * not start and look healthy -- the same reasoning as refusing the silent
   * demo-mode fallback below.
   *
   * Demo mode is exempt: routes/demo.js signs with its own secret and holds no
   * real user data, so requiring a production-strength JWT_SECRET to run a
   * local demo would be friction with no security value.
   */
  const demoMode = shouldUseDemoMode();
  if (!demoMode) assertJwtSecret();

  if (demoMode) {
    const { initDemoStore } = require('./db/demoStore');
    await initDemoStore();

    // The in-memory store is plain objects, so there is no migration to miss.
    setMediaColumnSupport(true);

    app.get('/api/health', (req, res) =>
      res.json({
        status: 'OK',
        message: 'Nexora API running (DEMO MODE)',
        version: appVersion.version,
        db: 'demo-memory',
        realBackend: false,
        // Withheld in production even when the demo was started deliberately —
        // see utils/demoMode.js.
        ...(mayPublishDemoLogin()
          ? { demoLogin: { email: 'demo@nexora.com', password: 'demo1234' } }
          : {}),
        hint: 'Set real SUPABASE_* keys and DEMO_MODE=false for production backend'
      })
    );
    app.get('/api/ready', (req, res) => res.json({ ready: true, demo: true, version: appVersion.version }));

    app.use('/api', require('./routes/demo'));

    // Same handler as the real path -- see the note there. Demo mode has no
    // real data, but it has the same routes, and a second implementation is
    // how the two drift.
    app.use((err, req, res, next) => sendError(res, err, req));

    if (shouldListen) {
      app.listen(PORT, () => {
        console.log('');
        console.log('Nexora server  http://localhost:' + PORT);
        console.log('DEMO MODE (in-memory)');
        console.log('');
      });
    }
    return app;
  }

  // real db path
  const { getSupabase } = require('./db/supabase');

  try {
    const db = getSupabase();
    // Fast connectivity check (full table scan only for local listen / health detail)
    const { error: pingError } = await db.from('users').select('id', { head: true, count: 'exact' }).limit(1);
    if (pingError) {
      throw new Error(pingError.message || 'Cannot reach users table');
    }
    if (shouldListen) {
      const tableStatus = await checkSupabaseTables(db);
      const missing = Object.entries(tableStatus).filter(([, v]) => !v.ok);
      if (missing.length) {
        console.error('Required tables missing or inaccessible:');
        missing.forEach(([t, v]) => console.error(`   - ${t}: ${v.error}`));
        console.error('   Run server/db/migrations/001_setup_step_a.sql, then restart.\n');
        process.exit(1);
      }
    }
    console.log('Connected to Supabase Postgres');

    // Migration 008 is optional at boot: probe for its columns rather than
    // assuming them. Selecting a column PostgREST cannot find fails the whole
    // query, so without this a deploy landing before the migration would 500
    // the feed, leaderboard, search and every author lookup at once.
    {
      const { error } = await db.from('users').select('avatar_thumb_url, cover_url').limit(1);
      setMediaColumnSupport(!error);
      if (error) {
        console.warn('Profile media columns absent — avatar/cover upload is disabled.');
        console.warn('   Run server/db/migrations/008_profile_media.sql to enable it.');
      }
    }

    /*
     * The refresh_tokens table is not optional the way the media columns are.
     * Without it every login still succeeds and then dies fifteen minutes later
     * when the first refresh fails — which reads as "the app logs me out at
     * random" rather than "a migration is missing". Say so loudly at boot.
     */
    {
      const { error } = await db.from('refresh_tokens').select('id').limit(1);
      if (error) {
        console.error('');
        console.error('  refresh_tokens table is MISSING.');
        console.error('  Logins will work, then every session will end after 15 minutes.');
        console.error('  Run server/db/migrations/009_auth_tokens.sql in the Supabase SQL Editor.');
        console.error('');
      }
    }
  } catch (err) {
    console.error('Supabase setup error:', err.message);
    if (shouldListen) {
      console.error('   Fix server/.env SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
      process.exit(1);
    }
    app.get('/api/health', (req, res) =>
      res.status(503).json({ status: 'ERROR', message: err.message })
    );
    app.get('/api/ready', (req, res) => res.status(503).json({ ready: false, error: err.message }));
    app.use('/api', (req, res) => res.status(503).json({ message: err.message || 'API not ready' }));
    return app;
  }

  app.get('/api/health', async (req, res) => {
    try {
      const db = getSupabase();
      const tables = await checkSupabaseTables(db);
      const allOk = Object.values(tables).every(t => t.ok);
      res.status(allOk ? 200 : 503).json({
        status: allOk ? 'OK' : 'DEGRADED',
        message: 'Nexora API running (Supabase)',
        version: appVersion.version,
        db: 'supabase',
        realBackend: allOk,
        storage: process.env.USE_SUPABASE_STORAGE === 'true' ? 'supabase' : 'local',
        emailConfigured: !!(process.env.EMAIL_USER && process.env.EMAIL_USER !== 'your_email@gmail.com'),
        paymentsConfigured: !!(process.env.RAZORPAY_KEY_ID && !String(process.env.RAZORPAY_KEY_ID).includes('YOUR_KEY')),
        uptimeSec: Math.floor(process.uptime()),
        tables
      });
    } catch (e) {
      res.status(503).json({ status: 'ERROR', message: e.message, db: 'supabase' });
    }
  });

  app.get('/api/ready', async (req, res) => {
    try {
      const { error } = await getSupabase().from('users').select('id', { head: true, count: 'exact' }).limit(1);
      if (error) return res.status(503).json({ ready: false, error: error.message });
      res.json({ ready: true, version: appVersion.version });
    } catch (e) {
      res.status(503).json({ ready: false, error: e.message });
    }
  });

  mountRealRoutes(app);

  app.use('/api', (req, res) => {
    res.status(404).json({ message: `API route not found: ${req.method} ${req.originalUrl}` });
  });

  /*
   * Everything that reaches Express's error path goes through sendError.
   *
   * This returned err.message verbatim, which for a PostgREST or Postgres
   * failure is raw database text -- table names, column names, constraint
   * names. utils/respond.js already decides what is safe to surface, and
   * asyncHandler already routes through it, so the obvious reading was that
   * this handler was unreachable.
   *
   * It is not. Fifteen real routes are not wrapped in asyncHandler and land
   * here: all five of ai.js, all four of cron.js, five in users.js, three in
   * auth.js, two in subscriptions.js, one in posts.js. A handler that is only
   * correct on the wrapped routes is the same partial-coverage problem that
   * produced the bug -- so the fix is one decision covering both paths, rather
   * than a list of routes to keep in sync. The list is what went stale.
   *
   * sendError keeps isSafeSetupError, so a genuine schema or configuration
   * problem still surfaces as a 503 with its message; everything else becomes a
   * generic message plus a requestId the user can quote.
   */
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    sendError(res, err, req, 'Something went wrong on our end', status);
  });

  if (shouldListen) {
    app.listen(PORT, () => {
      console.log('');
      console.log('Nexora server  http://localhost:' + PORT);
      console.log('Database:     Supabase Postgres (real backend)');
      console.log('Health:        http://localhost:' + PORT + '/api/health');
      console.log('Frontend:      ' + (process.env.CLIENT_URL || 'http://localhost:5173'));
      console.log('');
    });
  }

  return app;
}

function getApp() {
  if (!bootPromise) bootPromise = startServer({ listen: false });
  return bootPromise;
}

// Local / Render / Railway: node index.js
if (require.main === module) {
  startServer({ listen: true });
}

// Vercel serverless: export handler
module.exports = async (req, res) => {
  const readyApp = await getApp();
  return readyApp(req, res);
};
