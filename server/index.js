const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const { apiLimiter } = require('./middleware/rateLimit');

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

// CORS — allow client origin(s)
const clientOrigins = (process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || clientOrigins.includes(origin) || clientOrigins.includes('*')) {
      return cb(null, true);
    }
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return cb(null, true);
    }
    // Allow any vercel.app preview/production host for this project
    if (/\.vercel\.app$/i.test(origin || '')) {
      return cb(null, true);
    }
    return cb(null, false);
  },
  credentials: true
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag: true
}));
app.use('/api', apiLimiter);

const appVersion = require('./version');
app.get('/api/version', (req, res) => {
  res.json({
    ...appVersion,
    demoMode: null,
    env: process.env.NODE_ENV || 'development'
  });
});

function isPlaceholderConfig(url, key) {
  if (!url || !key) return true;
  const bad = ['YOUR_PROJECT_REF', 'your_service_role_key', 'your_service_role_key_here', 'xxxxxxxx'];
  return bad.some(b => url.includes(b) || key.includes(b));
}

function shouldUseDemoMode() {
  if (process.env.DEMO_MODE === 'false' || process.env.DEMO_MODE === '0') {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (isPlaceholderConfig(url, key)) {
      console.warn('DEMO_MODE=false but Supabase keys missing/placeholder → using DEMO until keys are set.');
      return true;
    }
    return false;
  }
  if (process.env.DEMO_MODE === 'true' || process.env.DEMO_MODE === '1') return true;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  return isPlaceholderConfig(url, key);
}

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
  appInstance.use('/api/notifications', require('./routes/notifications'));
  appInstance.use('/api/bookmarks', require('./routes/bookmarks'));
  appInstance.use('/api/search', require('./routes/search'));
  appInstance.use('/api/spaces', require('./routes/spaces'));
  appInstance.use('/api/challenges', require('./routes/challenges'));
  appInstance.use('/api/ai', require('./routes/ai'));
  appInstance.use('/api/digests', require('./routes/digests'));
  appInstance.use('/api', require('./routes/safety'));
  appInstance.use('/api/admin', require('./routes/admin'));
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
  if (!process.env.PUBLIC_API_URL && process.env.VERCEL_URL) {
    process.env.PUBLIC_API_URL = `https://${process.env.VERCEL_URL}`;
  }

  const demoMode = shouldUseDemoMode();

  if (demoMode) {
    const { initDemoStore } = require('./db/demoStore');
    await initDemoStore();

    app.get('/api/health', (req, res) =>
      res.json({
        status: 'OK',
        message: 'Nexora API running (DEMO MODE)',
        version: appVersion.version,
        db: 'demo-memory',
        realBackend: false,
        demoLogin: { email: 'demo@nexora.com', password: 'demo1234' },
        hint: 'Set real SUPABASE_* keys and DEMO_MODE=false for production backend'
      })
    );
    app.get('/api/ready', (req, res) => res.json({ ready: true, demo: true, version: appVersion.version }));

    app.use('/api', require('./routes/demo'));

    app.use((err, req, res, next) => {
      console.error('API error:', err.message);
      res.status(500).json({ message: err.message || 'Server error' });
    });

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

  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('API error:', err.message);
    else console.warn('API client error:', err.message);
    res.status(status).json({
      message: err.message || 'Server error',
      ...(process.env.NODE_ENV !== 'production' && err.stack ? { stack: err.stack } : {})
    });
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
