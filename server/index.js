const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const { apiLimiter } = require('./middleware/rateLimit');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Ensure upload dirs exist
['uploads', 'uploads/posts', 'uploads/avatars'].forEach((dir) => {
  const full = path.join(__dirname, dir);
  if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
});

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false
}));

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
    return cb(null, false);
  },
  credentials: true
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/api', apiLimiter);

const appVersion = require('./version');
app.get('/api/version', (req, res) => {
  res.json({
    ...appVersion,
    demoMode: null, // filled in health after boot mode is known
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
      console.warn('⚠️  DEMO_MODE=false but Supabase keys missing/placeholder → using DEMO until keys are set.');
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

function mountRealRoutes(app) {
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/posts', require('./routes/posts'));
  app.use('/api/questions', require('./routes/questions'));
  app.use('/api/answers', require('./routes/answers'));
  app.use('/api/subscriptions', require('./routes/subscriptions'));
  app.use('/api/rewards', require('./routes/rewards'));
  app.use('/api/users', require('./routes/users'));
  app.use('/api/notifications', require('./routes/notifications'));
  app.use('/api/bookmarks', require('./routes/bookmarks'));
  app.use('/api/search', require('./routes/search'));
  app.use('/api/spaces', require('./routes/spaces'));
  app.use('/api/challenges', require('./routes/challenges'));
  app.use('/api/ai', require('./routes/ai'));
  app.use('/api/digests', require('./routes/digests'));
  // blocks + reports (paths: /api/blocks, /api/reports)
  app.use('/api', require('./routes/safety'));
  app.use('/api/admin', require('./routes/admin'));
}

async function startServer() {
  process.on('uncaughtException', (err) => {
    console.error('uncaughtException:', err.message);
  });
  process.on('unhandledRejection', (err) => {
    console.error('unhandledRejection:', err?.message || err);
  });

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

    app.use('/api', require('./routes/demo'));

    app.use((err, req, res, next) => {
      console.error('API error:', err.message);
      res.status(500).json({ message: err.message || 'Server error' });
    });

    app.listen(PORT, () => {
      console.log('');
      console.log('🚀 Nexora server  http://localhost:' + PORT);
      console.log('🧪 DEMO MODE (in-memory) — temporary until Supabase is configured');
      console.log('   demo@nexora.com / demo1234');
      console.log('');
      console.log('📘 Real backend setup:');
      console.log('   1) Run server/db/setup_step_a.sql in Supabase SQL Editor');
      console.log('   2) Put real keys in server/.env');
      console.log('   3) DEMO_MODE=false');
      console.log('   4) npm run verify:supabase');
      console.log('');
    });
    return;
  }

  // ── Production: Supabase Postgres ──
  const { getSupabase } = require('./db/supabase');

  try {
    const db = getSupabase();
    const tableStatus = await checkSupabaseTables(db);
    const missing = Object.entries(tableStatus).filter(([, v]) => !v.ok);
    if (missing.length) {
      console.error('❌ Required tables missing or inaccessible:');
      missing.forEach(([t, v]) => console.error(`   - ${t}: ${v.error}`));
      console.error('   Run server/db/setup_step_a.sql in Supabase SQL Editor, then restart.\n');
      process.exit(1);
    }
    console.log('✅ Connected to Supabase Postgres (all tables OK)');
  } catch (err) {
    console.error('❌ Supabase setup error:', err.message);
    console.error('   Fix server/.env SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
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

  // Lightweight readiness for uptime monitors (no table scan)
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

  // 404 for unknown API paths
  app.use('/api', (req, res) => {
    res.status(404).json({ message: `API route not found: ${req.method} ${req.originalUrl}` });
  });

  app.use((err, req, res, next) => {
    console.error('API error:', err.message);
    res.status(err.status || 500).json({ message: err.message || 'Server error' });
  });

  app.listen(PORT, () => {
    console.log('');
    console.log('🚀 Nexora server  http://localhost:' + PORT);
    console.log('🗄️  Database:     Supabase Postgres (real backend)');
    console.log('🔑 Health:        http://localhost:' + PORT + '/api/health');
    console.log('🌐 Frontend:      ' + (process.env.CLIENT_URL || 'http://localhost:5173'));
    console.log('');
    console.log('   Register a NEW user — data persists in Supabase Table Editor → users');
    console.log('');
  });
}

startServer();
