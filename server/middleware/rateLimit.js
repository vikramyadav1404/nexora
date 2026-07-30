const rateLimit = require('express-rate-limit');
const { getSupabase } = require('../db/supabase');

/**
 * Postgres-backed store for express-rate-limit.
 *
 * The default MemoryStore keeps its counters in one Node process's heap. That
 * is fine on Render (one long-lived process) but close to useless on Vercel:
 * concurrent lambdas each hold a separate counter and every cold start resets
 * to zero, so the effective limit is multiplied by the instance count. An
 * attacker spreading login attempts across instances barely felt `authLimiter`.
 *
 * Counters now live in the `rate_limits` table (migration 005), incremented by
 * the `rate_limit_hit` RPC so the read-modify-write is atomic.
 *
 * Fails OPEN: if the database is unreachable we allow the request rather than
 * locking everyone out of the app. Rate limiting is a mitigation, not the
 * authentication boundary.
 */
class PostgresStore {
  constructor() {
    this.windowMs = 60_000;
    this.prefix = 'rl';
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  async increment(key) {
    const now = Date.now();
    try {
      const { data, error } = await getSupabase().rpc('rate_limit_hit', {
        p_key: `${this.prefix}:${key}`,
        p_window_ms: this.windowMs
      });
      if (error) throw error;

      const row = Array.isArray(data) ? data[0] : data;
      return {
        totalHits: row?.hits ?? 1,
        resetTime: row?.expires_at ? new Date(row.expires_at) : new Date(now + this.windowMs)
      };
    } catch (err) {
      // Missing migration is the likely cause in dev — say so once, then allow.
      if (!this._warned) {
        this._warned = true;
        console.warn(
          `rate limit store unavailable (${err.message}); failing open. ` +
          'Run server/db/migrations/005_hardening.sql to enable durable limits.'
        );
      }
      return { totalHits: 1, resetTime: new Date(now + this.windowMs) };
    }
  }

  async decrement(key) {
    try {
      await getSupabase().rpc('rate_limit_hit', {
        p_key: `${this.prefix}:${key}`,
        p_window_ms: this.windowMs
      });
    } catch { /* best effort */ }
  }

  async resetKey(key) {
    try {
      await getSupabase().rpc('rate_limit_reset', { p_key: `${this.prefix}:${key}` });
    } catch { /* best effort */ }
  }
}

/**
 * Demo mode has no database, and a single local process makes MemoryStore
 * correct anyway — only reach for Postgres when we're actually on Supabase.
 */
function makeStore() {
  const demo = process.env.DEMO_MODE === 'true' || process.env.DEMO_MODE === '1';
  if (demo) return undefined;
  return new PostgresStore();
}

function limiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store: makeStore(),
    message: { message }
  });
}

// general API traffic
const apiLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_API || 400),
  message: 'Too many requests. Try again in a bit.'
});

// login / register / forgot
const authLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AUTH || 30),
  message: 'Too many login attempts. Wait 15 minutes.'
});

// otp, password change, delete account
const sensitiveLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_SENSITIVE || 10),
  message: 'Too many attempts. Try again later.'
});

// posts / reports spam guard
const writeLimiter = limiter({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_WRITE || 30),
  message: 'Slow down a little.'
});

// Claude-backed endpoints — these cost real money per call, so they get their
// own bucket rather than sharing the generous general one.
const aiLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AI || 40),
  message: 'You have used a lot of AI assists this hour. Try again later.'
});

module.exports = { apiLimiter, authLimiter, sensitiveLimiter, writeLimiter, aiLimiter, PostgresStore };
