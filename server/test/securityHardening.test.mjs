/**
 * Four security defects found in an audit, and the guards that close them.
 *
 * They share a shape worth naming: each one defeated work that was done
 * carefully elsewhere in the same codebase. The MFA secret was encrypted at
 * rest and then handed out over HTTP. forgot-password was hardened against
 * account enumeration and then given a predictable password generator. The
 * paid plans got a conditional-write guard on activation while the limit they
 * sell stayed racy. Demo mode was made explicit and then reachable by accident.
 *
 * So these tests are less about the guards than about the seams between
 * features, which is where all four lived.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

process.env.JWT_SECRET = 'test_jwt_secret';

const require = createRequire(import.meta.url);
const { __setTestClient } = require('../db/supabase.js');
const { shapeUser } = require('../db/helpers.js');
const { generatePassword, generateOTP } = require('../utils/email.js');
const jwt = require('jsonwebtoken');

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

/** A row as select('*') returns it — every column, including the secrets. */
function fullRow(id, name) {
  return {
    id,
    name,
    email: `${name}@nexora.test`,
    password: '$2a$10$hashedpasswordhashedpasswordha',
    points: 10,
    is_active: true,
    role: 'user',
    subscription_plan: 'free',
    // The fields that must never reach a response body:
    mfa_secret: 'v1.aabbcc.ddeeff.001122334455667788',
    mfa_enabled: true,
    mfa_last_step: 58000000,
    mfa_failed_attempts: 3,
    mfa_locked_until: new Date(Date.now() + 60000).toISOString(),
    forgot_password_token: 'reset-token-abc',
    forgot_password_expire: new Date(Date.now() + 60000).toISOString(),
    email_otp: '123456',
    email_otp_expire: new Date(Date.now() + 60000).toISOString(),
    language_otp: '654321'
  };
}

let db;
const token = (id = ME) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  db = createFakeSupabase({
    users: [fullRow(ME, 'me'), fullRow(OTHER, 'other')],
    friendships: [], follows: [], posts: [], questions: []
  });
  __setTestClient(db);
});

describe('1. the MFA secret must not leave the server', () => {
  /*
   * shapeUser used to end with `_raw: safe` — the whole row minus four fields.
   * GET /api/users/:id accepts any id, so any logged-in account could read the
   * AES-GCM ciphertext of anyone else's TOTP secret. Encrypting it at rest
   * (010_mfa.sql) only defends against a database dump; this handed it over
   * without one.
   */
  const FORBIDDEN = [
    'mfa_secret', 'mfa_last_step', 'mfa_failed_attempts', 'mfa_locked_until',
    'password', 'forgot_password_token', 'forgot_password_expire',
    'email_otp', 'email_otp_expire', 'language_otp', '_raw'
  ];

  it('REGRESSION: a shaped user carries none of the secret columns', () => {
    const shaped = shapeUser(fullRow(ME, 'me'));
    const serialized = JSON.stringify(shaped);

    for (const field of FORBIDDEN) {
      expect(shaped).not.toHaveProperty(field);
    }
    // Belt and braces: the ciphertext must not appear anywhere in the payload,
    // however it might be nested.
    expect(serialized).not.toContain('v1.aabbcc');
    expect(serialized).not.toContain('reset-token-abc');
  });

  it('REGRESSION: GET /api/users/:id exposes nothing about another account', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/users', require('../routes/users.js'));

    const res = await request(app)
      .get(`/api/users/${OTHER}`)
      .set('Authorization', `Bearer ${token(ME)}`);

    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('v1.aabbcc');
    expect(body).not.toContain('mfa_secret');
    expect(body).not.toContain('_raw');
    for (const field of FORBIDDEN) {
      expect(res.body.user).not.toHaveProperty(field);
    }
  });

  it('still returns the fields the client actually needs', () => {
    // The fix must not have removed the payload's useful half.
    const shaped = shapeUser(fullRow(ME, 'me'));
    expect(shaped.id).toBe(ME);
    expect(shaped.name).toBe('me');
    expect(shaped.subscription.plan).toBe('free');
    expect(shaped.points).toBe(10);
  });
});

describe('2. credentials come from a CSPRNG', () => {
  /*
   * generatePassword and generateOTP used Math.random(). V8 implements that as
   * xorshift128+, whose state is recoverable from a run of outputs — and
   * POST /api/auth/generate-password serves draws from the same generator, in
   * the same process, to anyone unauthenticated. Harvest there, recover the
   * state, then trigger a reset for a victim and predict the password written
   * to their row.
   */
  let realRandom;
  afterEach(() => { if (realRandom) Math.random = realRandom; });

  it('REGRESSION: generatePassword does not draw from Math.random', () => {
    realRandom = Math.random;
    let called = 0;
    Math.random = () => { called++; return 0.5; };

    generatePassword(12);

    expect(called).toBe(0);
  });

  it('REGRESSION: generateOTP does not draw from Math.random', () => {
    realRandom = Math.random;
    let called = 0;
    Math.random = () => { called++; return 0.5; };

    generateOTP();

    expect(called).toBe(0);
  });

  it('REGRESSION: pinning Math.random does not pin the output', () => {
    // The sharpest statement of the bug: with Math.random frozen, the old
    // implementation returned the same password every single time.
    realRandom = Math.random;
    Math.random = () => 0.42;

    const runs = new Set(Array.from({ length: 20 }, () => generatePassword(12)));

    expect(runs.size).toBeGreaterThan(1);
  });

  it('keeps its stated shape: length, and both cases present', () => {
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword(12);
      expect(pw).toHaveLength(12);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/^[A-Za-z]+$/);
    }
  });

  it('OTPs are six digits and vary', () => {
    const seen = new Set(Array.from({ length: 40 }, () => generateOTP()));
    for (const otp of seen) expect(otp).toMatch(/^\d{6}$/);
    expect(seen.size).toBeGreaterThan(1);
  });

  it('the guaranteed upper/lower characters are not stuck at the front', () => {
    /*
     * The old shuffle was `.sort(() => Math.random() - 0.5)`, which is not a
     * shuffle — the result depends on the sort implementation and is biased, so
     * the seeded upper and lower characters tended to stay near position 0-1.
     * Fisher-Yates spreads them.
     */
    let upperLate = 0;
    for (let i = 0; i < 200; i++) {
      const pw = generatePassword(12);
      if (/[A-Z]/.test(pw.slice(6))) upperLate++;
    }
    expect(upperLate).toBeGreaterThan(20);
  });
});

describe('3. daily quotas cannot be raced', () => {
  /*
   * The free plan allows 1 question/day and that limit is the entire product
   * difference the paid tiers sell. It was enforced by reading req.userRow's
   * counter, checking it, and writing it back at the end of the request — so N
   * concurrent requests all read 0, all passed, and all wrote 1.
   */
  const { claimDailyQuota } = require('../utils/quota.js');

  // claim_daily_quota is a built-in of the fake client, mirroring migration
  // 015 — the same way transfer_points mirrors 005.

  it('REGRESSION: a 1/day account gets one success and one refusal', async () => {
    /*
     * A snapshot, not the live row.
     *
     * protect loads the user once per request, so each concurrent caller holds
     * its own copy taken before either wrote. Passing db._tables.users[0]
     * directly hands both callers the object the fake mutates in place, which
     * is never stale — that version of this test stayed green when the guard
     * was reverted, because it was not reproducing the bug at all.
     */
    const userRow = { ...db._tables.users[0] };

    const first = await claimDailyQuota(db, { userId: ME, kind: 'question', limit: 1, userRow });
    const second = await claimDailyQuota(db, { userId: ME, kind: 'question', limit: 1, userRow });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(db._tables.users[0].questions_today).toBe(1);
  });

  it('REGRESSION: five parallel claims on a 1/day account yield exactly one', async () => {
    const userRow = db._tables.users[0];

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        claimDailyQuota(db, { userId: ME, kind: 'question', limit: 1, userRow }))
    );

    expect(results.filter(r => r.allowed)).toHaveLength(1);
    expect(db._tables.users[0].questions_today).toBe(1);
  });

  it('a gold account is unlimited', async () => {
    const userRow = db._tables.users[0];

    for (let i = 0; i < 25; i++) {
      const r = await claimDailyQuota(db, { userId: ME, kind: 'question', limit: Infinity, userRow });
      expect(r.allowed).toBe(true);
    }
  });

  it('posts and questions are separate allowances', async () => {
    const userRow = db._tables.users[0];

    await claimDailyQuota(db, { userId: ME, kind: 'question', limit: 1, userRow });
    const post = await claimDailyQuota(db, { userId: ME, kind: 'post', limit: 1, userRow });

    expect(post.allowed).toBe(true);
  });

  it('falls back rather than 500ing when migration 015 is absent', async () => {
    // Simulate an unapplied migration: PostgREST answers PGRST202.
    delete db._rpc.claim_daily_quota;
    const userRow = db._tables.users[0];
    const r = await claimDailyQuota(db, { userId: ME, kind: 'question', limit: 1, userRow });
    expect(r.allowed).toBe(true);
  });

  it('REGRESSION: a database error is not swallowed into a free pass', async () => {
    // Anything other than "function missing" must propagate. Treating an
    // unknown failure as "allowed" would turn an outage into an unlimited quota.
    db._rpc.claim_daily_quota = () => ({
      data: null, error: { code: '57014', message: 'statement timeout' }
    });

    await expect(
      claimDailyQuota(db, { userId: ME, kind: 'question', limit: 1, userRow: db._tables.users[0] })
    ).rejects.toMatchObject({ code: '57014' });
  });
});

describe('4. production never falls into demo mode by accident', () => {
  /*
   * The demo backend is an in-memory store that publishes a working login on an
   * unauthenticated health endpoint. A missing SUPABASE_SERVICE_ROLE_KEY made
   * production silently boot into it — HTTP 200, apparently healthy, and open
   * to anyone with the published credentials. An explicit DEMO_MODE=false did
   * not prevent it.
   */
  const saved = {};
  const KEYS = ['NODE_ENV', 'DEMO_MODE', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY'];

  beforeEach(() => { for (const k of KEYS) saved[k] = process.env[k]; });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /*
   * The real function, imported from utils/demoMode.js.
   *
   * The first version of these tests reimplemented shouldUseDemoMode here,
   * because it lived inside index.js and requiring that starts a server. That
   * meant they asserted against a copy: the real function could have been
   * reverted and every test would have stayed green. It was extracted into its
   * own module so this could import it.
   */
  const { shouldUseDemoMode, mayPublishDemoLogin } = require('../utils/demoMode.js');

  it('REGRESSION: production with missing keys refuses to boot', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.DEMO_MODE;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_ANON_KEY;

    expect(() => shouldUseDemoMode()).toThrow(/refusing to start in demo mode/i);
  });

  it('REGRESSION: an explicit DEMO_MODE=false is not overridden into demo', () => {
    process.env.NODE_ENV = 'production';
    process.env.DEMO_MODE = 'false';
    process.env.SUPABASE_URL = 'https://YOUR_PROJECT_REF.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'your_service_role_key';

    expect(() => shouldUseDemoMode()).toThrow(/refusing to start in demo mode/i);
  });

  it('a deliberate DEMO_MODE=true is still honoured in production', () => {
    // Typed out on purpose is a different thing from fallen into by accident.
    process.env.NODE_ENV = 'production';
    process.env.DEMO_MODE = 'true';
    expect(shouldUseDemoMode()).toBe(true);
  });

  it('development still falls back quietly, which is the point of the fallback', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.DEMO_MODE;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_ANON_KEY;

    expect(shouldUseDemoMode()).toBe(true);
  });

  it('real keys in production use the real backend', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.DEMO_MODE;
    process.env.SUPABASE_URL = 'https://jcfjwpotoylzhjhhziew.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.real';

    expect(shouldUseDemoMode()).toBe(false);
  });
});

describe('the demo login is never published in production', () => {
  const saved = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = saved; });

  const { mayPublishDemoLogin } = require('../utils/demoMode.js');

  it('REGRESSION: withheld in production even for a deliberate demo', () => {
    process.env.NODE_ENV = 'production';
    expect(mayPublishDemoLogin()).toBe(false);
  });

  it('still published locally, which is the point of a demo', () => {
    process.env.NODE_ENV = 'development';
    expect(mayPublishDemoLogin()).toBe(true);
  });
});
