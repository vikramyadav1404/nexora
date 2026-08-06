/**
 * Rate limiter store keying.
 *
 * This exists because of a bug that was invisible for as long as the store did
 * not work. PostgresStore hardcoded its key prefix to 'rl', and the key
 * express-rate-limit hands it is just the client IP — so all six limiters
 * incremented one shared row.
 *
 * apiLimiter is mounted on every /api request, so roughly ten page loads spent
 * sensitiveLimiter's entire hourly budget of ten. Password change, email
 * verification, account deletion and MFA setup then returned 429 to users who
 * had done nothing unusual.
 *
 * It stayed hidden because migration 005 had never been applied: every call
 * threw, the store failed open by design, and nothing was ever counted. Applying
 * 005 turned a dormant bug into a live one, which is exactly the kind of thing
 * a test should hold down.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Records every key the store sends to the rate_limit_hit RPC. */
function trackingClient(seen) {
  return {
    rpc(name, args) {
      if (name === 'rate_limit_hit') {
        seen.push(args.p_key);
        return Promise.resolve({
          data: [{ hits: seen.filter(k => k === args.p_key).length, expires_at: new Date(Date.now() + 60000).toISOString() }],
          error: null
        });
      }
      return Promise.resolve({ data: null, error: null });
    }
  };
}

let seen;
let PostgresStore;

beforeEach(() => {
  seen = [];
  process.env.DEMO_MODE = 'false';
  const { __setTestClient } = require('../db/supabase.js');
  __setTestClient(trackingClient(seen));
  ({ PostgresStore } = require('../middleware/rateLimit.js'));
});

describe('PostgresStore key namespacing', () => {
  it('REGRESSION: two limiters do not share a counter', async () => {
    const api = new PostgresStore('api');
    const sensitive = new PostgresStore('sensitive');

    // Same client, same IP — the only thing separating them is the limiter name.
    await api.increment('1.2.3.4');
    await sensitive.increment('1.2.3.4');

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('a burst of general traffic does not consume the sensitive budget', async () => {
    const api = new PostgresStore('api');
    const sensitive = new PostgresStore('sensitive');

    for (let i = 0; i < 25; i++) await api.increment('1.2.3.4');
    const { totalHits } = await sensitive.increment('1.2.3.4');

    // Before the fix this returned 26, and sensitiveLimiter's max of 10 was
    // already blown by ordinary page loads.
    expect(totalHits).toBe(1);
  });

  it('keeps counting the same client within one limiter', async () => {
    const auth = new PostgresStore('auth');

    await auth.increment('9.9.9.9');
    const second = await auth.increment('9.9.9.9');
    expect(second.totalHits).toBe(2);

    // A different client must not inherit that count.
    const other = await auth.increment('8.8.8.8');
    expect(other.totalHits).toBe(1);
  });

  it('every shipped limiter gets its own namespace', () => {
    const names = ['api', 'auth', 'sensitive', 'write', 'ai', 'upload'];
    const prefixes = names.map(n => new PostgresStore(n).prefix);
    expect(new Set(prefixes).size).toBe(names.length);
  });

  it('fails open when the store is unreachable', async () => {
    // Rate limiting is a mitigation, not the authentication boundary. A database
    // blip must not lock everyone out of the app.
    const { __setTestClient } = require('../db/supabase.js');
    __setTestClient({ rpc: () => Promise.reject(new Error('connection refused')) });

    const store = new PostgresStore('api');
    const { totalHits } = await store.increment('1.2.3.4');
    expect(totalHits).toBe(1);
  });
});
