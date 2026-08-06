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
  /**
   * `name` separates one limiter's counter from another's.
   *
   * It used to be a hardcoded 'rl' for every instance, and since the key
   * express-rate-limit passes is just the client IP, all five limiters
   * incremented a single shared row. apiLimiter runs on every /api request, so
   * roughly ten page loads exhausted sensitiveLimiter's hourly budget of ten —
   * and password change, email verification, account deletion and MFA setup all
   * started returning 429 to people who had done nothing wrong.
   *
   * The bug was invisible until migration 005 was applied, because until then
   * the store threw on every call and failed open, so nothing was ever counted.
   */
  constructor(name = 'default') {
    this.windowMs = 60_000;
    this.prefix = `rl:${name}`;
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
function makeStore(name) {
  const demo = process.env.DEMO_MODE === 'true' || process.env.DEMO_MODE === '1';
  if (demo) return undefined;
  return new PostgresStore(name);
}

/** `name` must be unique per limiter — it is what keeps the counters apart. */
function limiter({ name, windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store: makeStore(name),
    message: { message }
  });
}

// general API traffic
const apiLimiter = limiter({
  name: 'api',
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_API || 400),
  message: 'Too many requests. Try again in a bit.'
});

// login / register / forgot
const authLimiter = limiter({
  name: 'auth',
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AUTH || 30),
  message: 'Too many login attempts. Wait 15 minutes.'
});

// otp, password change, delete account
const sensitiveLimiter = limiter({
  name: 'sensitive',
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_SENSITIVE || 10),
  message: 'Too many attempts. Try again later.'
});

// posts / reports spam guard
const writeLimiter = limiter({
  name: 'write',
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_WRITE || 30),
  message: 'Slow down a little.'
});

// Claude-backed endpoints — these cost real money per call, so they get their
// own bucket rather than sharing the generous general one.
const aiLimiter = limiter({
  name: 'ai',
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AI || 40),
  message: 'You have used a lot of AI assists this hour. Try again later.'
});

// Signed upload URLs. Ten an hour is far more than a person changing their
// profile picture needs, and it caps how fast a compromised token could mint
// write access to the bucket.
const uploadLimiter = limiter({
  name: 'upload',
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_UPLOAD || 10),
  message: 'Too many upload requests this hour. Try again later.'
});

module.exports = {
  apiLimiter,
  authLimiter,
  sensitiveLimiter,
  writeLimiter,
  aiLimiter,
  uploadLimiter,
  PostgresStore
};
