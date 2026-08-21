/**
 * Two-factor authentication — the algorithm, the storage, and the login flow.
 *
 * Same createRequire setup as the other suites; see subscriptions.test.mjs for
 * why `import` is not used for server modules.
 *
 * The weight here is on the properties that are easy to get subtly wrong and
 * silently lose: that a code cannot be replayed inside its own window, that a
 * half-authenticated token opens nothing, and that guessing is bounded by
 * something other than the IP rate limiter — which fails open by design.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createRequire } from 'node:module';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

process.env.JWT_SECRET = 'test_jwt_secret';
process.env.MFA_SECRET_KEY = 'test_mfa_encryption_key_long_enough';

const require = createRequire(import.meta.url);
// Fixture hashes track the same cost knob as the source; see utils/bcryptCost.js.
const { fixtureCost } = require('../utils/bcryptCost.js');
const { __setTestClient } = require('../db/supabase.js');
const tokens = require('../utils/tokens.js');
const totp = require('../utils/totp.js');
const mfa = require('../utils/mfa.js');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const PASSWORD = 'correct-horse';
const USER_ID = '00000000-0000-4000-8000-0000000000mf'.replace('mf', 'af');

let db;
let secret;

function app() {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use('/api/auth', require('../routes/auth.js'));
  return a;
}

async function seed({ mfaEnabled = false, ...overrides } = {}) {
  secret = totp.generateSecret();
  db = createFakeSupabase({
    users: [{
      id: USER_ID,
      name: 'MFA Tester',
      email: 'mfa@nexora.test',
      password: await bcrypt.hash(PASSWORD, fixtureCost()),
      is_active: true,
      points: 0,
      mfa_enabled: mfaEnabled,
      mfa_secret: mfa.encryptSecret(secret),
      mfa_last_step: 0,
      mfa_failed_attempts: 0,
      mfa_locked_until: null,
      ...overrides
    }],
    refresh_tokens: [],
    mfa_backup_codes: []
  });
  __setTestClient(db);
  process.env.NODE_ENV = 'test';
}

const userRow = () => db._tables.users[0];
const login = () => request(app()).post('/api/auth/login').send({ email: 'mfa@nexora.test', password: PASSWORD });
const code = (at = Date.now()) => totp.generateCode(secret, at);

beforeEach(async () => { await seed(); });

// ------------------------------------------------------------
describe('TOTP algorithm', () => {
  it('matches the RFC 6238 test vectors', () => {
    // Appendix B seed, ASCII '12345678901234567890'. The published values are
    // eight digits; a six-digit code is the same number mod 1e6.
    const rfcSecret = totp.base32Encode(Buffer.from('12345678901234567890', 'ascii'));
    expect(rfcSecret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');

    const vectors = [
      [59, '287082'], [1111111109, '081804'], [1111111111, '050471'],
      [1234567890, '005924'], [2000000000, '279037'],
      // Past 2^32 seconds — catches a counter written as 32-bit.
      [20000000000, '353130']
    ];
    for (const [t, expected] of vectors) {
      expect(totp.generateCode(rfcSecret, t * 1000)).toBe(expected);
    }
  });

  it('accepts a code one step early or late, but not two', () => {
    const now = Date.now();
    const step = totp.STEP_SECONDS * 1000;

    expect(totp.verifyCode(secret, totp.generateCode(secret, now), { at: now })).not.toBeNull();
    expect(totp.verifyCode(secret, totp.generateCode(secret, now - step), { at: now })).not.toBeNull();
    expect(totp.verifyCode(secret, totp.generateCode(secret, now + step), { at: now })).not.toBeNull();

    expect(totp.verifyCode(secret, totp.generateCode(secret, now - 2 * step), { at: now })).toBeNull();
    expect(totp.verifyCode(secret, totp.generateCode(secret, now + 2 * step), { at: now })).toBeNull();
  });

  it('refuses anything that is not six digits', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', null, undefined]) {
      expect(totp.verifyCode(secret, bad)).toBeNull();
    }
  });

  it('refuses a step at or below the one already used', () => {
    const now = Date.now();
    const step = totp.currentStep(now);
    expect(totp.verifyCode(secret, totp.generateCode(secret, now), { at: now, afterStep: step })).toBeNull();
  });

  it('round-trips base32 and tolerates how people retype it', () => {
    const raw = Buffer.from('a longer secret!', 'ascii');
    const encoded = totp.base32Encode(raw);
    expect(totp.base32Decode(encoded)).toEqual(raw);
    // Lowercase, spaces and padding all appear when a secret is typed by hand.
    expect(totp.base32Decode(encoded.toLowerCase())).toEqual(raw);
    expect(totp.base32Decode(totp.formatSecretForDisplay(encoded))).toEqual(raw);
  });

  it('builds an otpauth URI carrying the issuer twice', () => {
    const uri = totp.otpauthUri(secret, { account: 'a@b.com' });
    // Prefix for older apps, parameter for newer ones. Dropping either leaves
    // the entry unlabelled on somebody's phone.
    expect(uri).toMatch(/^otpauth:\/\/totp\/Nexora%3Aa%40b\.com\?/);
    expect(uri).toContain('issuer=Nexora');
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

// ------------------------------------------------------------
describe('secret at rest', () => {
  it('is never stored in the clear', () => {
    const stored = mfa.encryptSecret(secret);
    expect(stored).not.toContain(secret);
    expect(stored.startsWith('v1.')).toBe(true);
    expect(mfa.decryptSecret(stored)).toBe(secret);
  });

  it('produces different ciphertext each time', () => {
    // A fixed IV would make identical secrets visibly identical in a dump.
    expect(mfa.encryptSecret(secret)).not.toBe(mfa.encryptSecret(secret));
  });

  it('returns null rather than garbage when the ciphertext is tampered with', () => {
    const stored = mfa.encryptSecret(secret);
    const parts = stored.split('.');
    parts[3] = Buffer.from('tampered-with-payload').toString('base64url');
    // GCM's tag is what catches this; CBC would decrypt to noise and fail later
    // somewhere far less obvious.
    expect(mfa.decryptSecret(parts.join('.'))).toBeNull();
  });

  it('returns null under a different key', () => {
    const stored = mfa.encryptSecret(secret);
    const original = process.env.MFA_SECRET_KEY;
    process.env.MFA_SECRET_KEY = 'a completely different key entirely';
    try {
      expect(mfa.decryptSecret(stored)).toBeNull();
    } finally {
      process.env.MFA_SECRET_KEY = original;
    }
  });

  it('survives malformed input without throwing', () => {
    for (const bad of ['', null, undefined, 'not-encrypted', 'v1.only.two', 'v2.a.b.c']) {
      expect(mfa.decryptSecret(bad)).toBeNull();
    }
  });
});

// ------------------------------------------------------------
describe('backup codes', () => {
  it('generates ten distinct codes with no ambiguous characters', async () => {
    const codes = await mfa.regenerateBackupCodes(USER_ID);

    expect(codes).toHaveLength(mfa.BACKUP_CODE_COUNT);
    expect(new Set(codes).size).toBe(mfa.BACKUP_CODE_COUNT);
    for (const c of codes) {
      expect(c).toMatch(/^[2-9A-HJ-NP-TV-Z]{5}-[2-9A-HJ-NP-TV-Z]{5}$/);
      // 0/O and 1/I/L are where transcription goes wrong.
      expect(c).not.toMatch(/[01OIL]/);
    }
  });

  it('stores only hashes', async () => {
    const codes = await mfa.regenerateBackupCodes(USER_ID);
    const stored = db._tables.mfa_backup_codes.map(r => r.code_hash).join(' ');
    for (const c of codes) {
      expect(stored).not.toContain(c);
      expect(stored).not.toContain(mfa.normalizeBackupCode(c));
    }
  });

  it('accepts a code once and never again', async () => {
    const [first] = await mfa.regenerateBackupCodes(USER_ID);

    expect(await mfa.consumeBackupCode(USER_ID, first)).toBe(true);
    expect(await mfa.consumeBackupCode(USER_ID, first)).toBe(false);
    expect(await mfa.countUnusedBackupCodes(USER_ID)).toBe(mfa.BACKUP_CODE_COUNT - 1);
  });

  it('matches regardless of case and separators', async () => {
    const [first] = await mfa.regenerateBackupCodes(USER_ID);
    const messy = first.toLowerCase().replace('-', ' ');
    expect(await mfa.consumeBackupCode(USER_ID, messy)).toBe(true);
  });

  it('rejects a code belonging to nobody', async () => {
    await mfa.regenerateBackupCodes(USER_ID);
    expect(await mfa.consumeBackupCode(USER_ID, 'ZZZZZ-ZZZZZ')).toBe(false);
  });

  it('regenerating invalidates the previous set', async () => {
    const [old] = await mfa.regenerateBackupCodes(USER_ID);
    await mfa.regenerateBackupCodes(USER_ID);

    // A sheet printed a year ago must stop working the moment new ones issue.
    expect(await mfa.consumeBackupCode(USER_ID, old)).toBe(false);
    expect(await mfa.countUnusedBackupCodes(USER_ID)).toBe(mfa.BACKUP_CODE_COUNT);
  });
});

// ------------------------------------------------------------
describe('login with MFA on', () => {
  beforeEach(async () => { await seed({ mfaEnabled: true }); });

  it('stops at the password and issues no session', async () => {
    const res = await login();

    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBe(true);
    expect(res.body.mfaToken).toBeTruthy();
    // The two things that would make the second factor pointless:
    expect(res.body.token).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(db._tables.refresh_tokens).toHaveLength(0);
  });

  it('issues a token that opens nothing', async () => {
    const { body } = await login();
    const me = await request(app()).get('/api/auth/me').set('Authorization', `Bearer ${body.mfaToken}`);

    expect(me.status).toBe(401);
    expect(me.body.message).toMatch(/additional verification/i);
    expect(jwt.decode(body.mfaToken).typ).toBe('mfa_pending');
  });

  it('completes with a valid code and only then creates a session', async () => {
    const { body } = await login();
    const res = await request(app())
      .post('/api/auth/mfa/verify')
      .send({ mfaToken: body.mfaToken, code: code() });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.email).toBe('mfa@nexora.test');
    expect(res.headers['set-cookie']).toBeDefined();
    expect(db._tables.refresh_tokens).toHaveLength(1);
    expect(jwt.decode(res.body.token).typ).toBe('access');
  });

  it('REGRESSION: the same code cannot be replayed inside its own window', async () => {
    // A TOTP code stays valid for a full 30 seconds. Without recording the step,
    // one shoulder-surfed or phished code works twice.
    const shared = code();

    const first = await request(app())
      .post('/api/auth/mfa/verify')
      .send({ mfaToken: (await login()).body.mfaToken, code: shared });
    expect(first.status).toBe(200);

    const second = await request(app())
      .post('/api/auth/mfa/verify')
      .send({ mfaToken: (await login()).body.mfaToken, code: shared });
    expect(second.status).toBe(401);
    expect(db._tables.refresh_tokens).toHaveLength(1);
  });

  it('accepts a backup code and reports how many are left', async () => {
    const codes = await mfa.regenerateBackupCodes(USER_ID);
    const { body } = await login();

    const res = await request(app())
      .post('/api/auth/mfa/verify')
      .send({ mfaToken: body.mfaToken, code: codes[0] });

    expect(res.status).toBe(200);
    expect(res.body.usedBackupCode).toBe(true);
    expect(res.body.backupCodesRemaining).toBe(mfa.BACKUP_CODE_COUNT - 1);
  });

  it('refuses an access token in place of the pending one', async () => {
    // Otherwise any live session could satisfy the very step it depends on.
    const access = tokens.signAccessToken(USER_ID);
    const res = await request(app())
      .post('/api/auth/mfa/verify')
      .send({ mfaToken: access, code: code() });

    expect(res.status).toBe(401);
  });

  it('refuses an expired pending token', async () => {
    const stale = jwt.sign({ id: USER_ID, typ: 'mfa_pending' }, process.env.JWT_SECRET, { expiresIn: '-1s' });
    const res = await request(app())
      .post('/api/auth/mfa/verify')
      .send({ mfaToken: stale, code: code() });

    expect(res.status).toBe(401);
  });

  it('refuses a code for a different secret', async () => {
    const { body } = await login();
    const res = await request(app())
      .post('/api/auth/mfa/verify')
      .send({ mfaToken: body.mfaToken, code: totp.generateCode(totp.generateSecret()) });

    expect(res.status).toBe(401);
    expect(db._tables.refresh_tokens).toHaveLength(0);
  });
});

// ------------------------------------------------------------
describe('brute force', () => {
  beforeEach(async () => { await seed({ mfaEnabled: true }); });

  it('locks the account after five wrong codes, independently of the rate limiter', async () => {
    // The IP limiter fails open when its store is down and is keyed by address,
    // so neither property protects a six-digit code. This counter follows the
    // account instead.
    const { body } = await login();

    for (let i = 0; i < mfa.MFA_MAX_ATTEMPTS - 1; i++) {
      const res = await request(app())
        .post('/api/auth/mfa/verify')
        .send({ mfaToken: body.mfaToken, code: '000000' });
      expect(res.status).toBe(401);
    }
    expect(userRow().mfa_locked_until).toBeFalsy();

    const locking = await request(app())
      .post('/api/auth/mfa/verify')
      .send({ mfaToken: body.mfaToken, code: '000000' });
    expect(locking.status).toBe(401);
    expect(userRow().mfa_locked_until).toBeTruthy();

    // Even the correct code is refused while locked.
    const correct = await request(app())
      .post('/api/auth/mfa/verify')
      .send({ mfaToken: body.mfaToken, code: code() });
    expect(correct.status).toBe(429);
    expect(correct.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(db._tables.refresh_tokens).toHaveLength(0);
  });

  it('never reveals how many attempts remain', async () => {
    const { body } = await login();
    const res = await request(app())
      .post('/api/auth/mfa/verify')
      .send({ mfaToken: body.mfaToken, code: '000000' });

    expect(JSON.stringify(res.body)).not.toMatch(/\d\s*(attempts?|tries|remaining|left)/i);
  });

  it('a success clears the run of failures', async () => {
    const { body } = await login();
    await request(app()).post('/api/auth/mfa/verify').send({ mfaToken: body.mfaToken, code: '000000' });
    expect(userRow().mfa_failed_attempts).toBe(1);

    await request(app()).post('/api/auth/mfa/verify').send({ mfaToken: body.mfaToken, code: code() });
    expect(userRow().mfa_failed_attempts).toBe(0);
  });
});

// ------------------------------------------------------------
describe('enrolment', () => {
  const auth = () => `Bearer ${tokens.signAccessToken(USER_ID)}`;

  it('setup stores a secret but leaves MFA off', async () => {
    const res = await request(app()).post('/api/auth/mfa/setup').set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.qr).toMatch(/^data:image\/png;base64,/);
    expect(res.body.uri).toContain('otpauth://totp/');
    // Enabling here would let a mis-scanned QR lock someone out permanently.
    expect(userRow().mfa_enabled).toBe(false);
  });

  it('enable requires a code that proves the app holds the secret', async () => {
    const setup = await request(app()).post('/api/auth/mfa/setup').set('Authorization', auth());

    const wrong = await request(app())
      .post('/api/auth/mfa/enable').set('Authorization', auth()).send({ code: '000000' });
    expect(wrong.status).toBe(401);
    expect(userRow().mfa_enabled).toBe(false);

    const right = await request(app())
      .post('/api/auth/mfa/enable').set('Authorization', auth())
      .send({ code: totp.generateCode(setup.body.secret) });

    expect(right.status).toBe(200);
    expect(right.body.backupCodes).toHaveLength(mfa.BACKUP_CODE_COUNT);
    expect(userRow().mfa_enabled).toBe(true);
    expect(userRow().mfa_enabled_at).toBeTruthy();
  });

  it('enabling ends every other session', async () => {
    // The password may already be known; a session opened with it would other-
    // wise keep refreshing for 30 days, untouched by the factor just added.
    await tokens.issueSession(USER_ID);
    await tokens.issueSession(USER_ID);

    const setup = await request(app()).post('/api/auth/mfa/setup').set('Authorization', auth());
    await request(app())
      .post('/api/auth/mfa/enable').set('Authorization', auth())
      .send({ code: totp.generateCode(setup.body.secret) });

    const live = db._tables.refresh_tokens.filter(t => !t.revoked_at);
    expect(live).toHaveLength(1); // only the one just issued to the caller
  });

  it('refuses to set up twice while it is already on', async () => {
    await seed({ mfaEnabled: true });
    const res = await request(app()).post('/api/auth/mfa/setup').set('Authorization', auth());
    expect(res.status).toBe(409);
  });
});

// ------------------------------------------------------------
describe('disabling', () => {
  const auth = () => `Bearer ${tokens.signAccessToken(USER_ID)}`;
  beforeEach(async () => { await seed({ mfaEnabled: true }); });

  it('needs the password as well as a code', async () => {
    // A stolen access token alone must not be able to strip the protection off.
    const noPassword = await request(app())
      .post('/api/auth/mfa/disable').set('Authorization', auth()).send({ code: code() });
    expect(noPassword.status).toBe(401);
    expect(userRow().mfa_enabled).toBe(true);

    const noCode = await request(app())
      .post('/api/auth/mfa/disable').set('Authorization', auth())
      .send({ password: PASSWORD, code: '000000' });
    expect(noCode.status).toBe(401);
    expect(userRow().mfa_enabled).toBe(true);
  });

  it('clears the secret and the backup codes when it succeeds', async () => {
    await mfa.regenerateBackupCodes(USER_ID);

    const res = await request(app())
      .post('/api/auth/mfa/disable').set('Authorization', auth())
      .send({ password: PASSWORD, code: code() });

    expect(res.status).toBe(200);
    expect(userRow().mfa_enabled).toBe(false);
    expect(userRow().mfa_secret).toBe('');
    expect(db._tables.mfa_backup_codes).toHaveLength(0);
  });

  it('accepts a backup code, since a lost phone is the reason to disable', async () => {
    const codes = await mfa.regenerateBackupCodes(USER_ID);
    const res = await request(app())
      .post('/api/auth/mfa/disable').set('Authorization', auth())
      .send({ password: PASSWORD, code: codes[0] });

    expect(res.status).toBe(200);
    expect(userRow().mfa_enabled).toBe(false);
  });

  it('regenerating backup codes needs the password', async () => {
    const bad = await request(app())
      .post('/api/auth/mfa/backup-codes').set('Authorization', auth())
      .send({ password: 'wrong' });
    expect(bad.status).toBe(401);

    const good = await request(app())
      .post('/api/auth/mfa/backup-codes').set('Authorization', auth())
      .send({ password: PASSWORD });
    expect(good.status).toBe(200);
    expect(good.body.backupCodes).toHaveLength(mfa.BACKUP_CODE_COUNT);
  });
});

// ------------------------------------------------------------
describe('login with MFA off', () => {
  it('is completely unchanged', async () => {
    const res = await login();

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.mfaRequired).toBeUndefined();
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('status reports it as off', async () => {
    const res = await request(app())
      .get('/api/auth/mfa/status')
      .set('Authorization', `Bearer ${tokens.signAccessToken(USER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.backupCodesRemaining).toBe(0);
  });
});

describe('a TOTP code is single-use', () => {
  /*
   * verifyTotpForUser writes mfa_last_step conditionally --
   * `.lt('mfa_last_step', step)` -- so whichever of two concurrent requests
   * writes second matches no rows. It then requested `.select('id')` and
   * discarded the result, returning `true` regardless, which made the guard
   * decorative: both requests logged in with the same six-digit code.
   *
   * consumeBackupCode a few lines above in the same file has always returned
   * the row count. This asserts they now agree.
   */
  it('REGRESSION: two callers racing the same code -- one wins, one is refused', async () => {
    await seed({ mfaEnabled: true });
    const row = { ...userRow() };
    const c = code();

    // Same stale row, exactly as two in-flight requests would hold.
    const first = await mfa.verifyTotpForUser(row, c);
    const second = await mfa.verifyTotpForUser(row, c);

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('REGRESSION: replaying a code after it has been used is refused', async () => {
    await seed({ mfaEnabled: true });
    const c = code();

    expect(await mfa.verifyTotpForUser({ ...userRow() }, c)).toBe(true);
    // Re-read: mfa_last_step has advanced.
    expect(await mfa.verifyTotpForUser({ ...userRow() }, c)).toBe(false);
  });

  it('a third replay is refused too', async () => {
    await seed({ mfaEnabled: true });
    const row = { ...userRow() };
    const c = code();

    const results = [];
    for (let i = 0; i < 3; i++) results.push(await mfa.verifyTotpForUser(row, c));

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('the login route refuses the replayed code and records a failed attempt', async () => {
    await seed({ mfaEnabled: true });
    const body = (await login()).body;
    const c = code();

    const ok = await request(app()).post('/api/auth/mfa/verify')
      .send({ mfaToken: body.mfaToken, code: c });
    expect(ok.status).toBe(200);
    expect(userRow().mfa_failed_attempts).toBe(0);

    const replay = await request(app()).post('/api/auth/mfa/verify')
      .send({ mfaToken: body.mfaToken, code: c });

    expect(replay.status).toBe(401);
    // A rejected code must count against the lockout, not be waved through.
    expect(userRow().mfa_failed_attempts).toBe(1);
  });
});

describe('a backup code is single-use', () => {
  /*
   * Not part of the replay fix -- consumeBackupCode always returned its row
   * count correctly. These exist because the mutation run found nothing
   * covering redemption at all, on the one credential that bypasses TOTP.
   *
   * What they cover is the SELECT filter: the lookup is scoped to
   * `.is('used_at', null)`, so a code already redeemed is not even a candidate
   * on the next call.
   *
   * What they cannot cover is the conditional update inside the loop. Replacing
   * its row count with `true` fails none of these, because sequential calls
   * never reach it -- the SELECT has already excluded the row. That guard is
   * for two requests interleaving between the SELECT and the UPDATE, which this
   * fake cannot produce: it is synchronous, so nothing interleaves. Same limit
   * as the payment race, where the fix was to call the function twice with one
   * stale read; there is no equivalent here because consumeBackupCode does its
   * own lookup rather than taking a row.
   *
   * Left in place rather than deleted: unreachable-in-test is not the same as
   * unnecessary, and this one is the difference between a backup code being
   * single-use and being usable twice under real concurrency.
   */
  it('REGRESSION: the same backup code cannot be redeemed twice', async () => {
    await seed({ mfaEnabled: true });
    const plain = 'A1B2C3D4E5';
    db._tables.mfa_backup_codes.push({
      id: 'bc1',
      user_id: USER_ID,
      code_hash: await bcrypt.hash(plain.replace(/-/g, '').toUpperCase(), fixtureCost()),
      used_at: null
    });

    expect(await mfa.consumeBackupCode(USER_ID, plain)).toBe(true);
    expect(await mfa.consumeBackupCode(USER_ID, plain)).toBe(false);
  });

  it('a third redemption is refused too', async () => {
    await seed({ mfaEnabled: true });
    const plain = 'Z9Y8X7W6V5';
    db._tables.mfa_backup_codes.push({
      id: 'bc2',
      user_id: USER_ID,
      code_hash: await bcrypt.hash(plain.replace(/-/g, '').toUpperCase(), fixtureCost()),
      used_at: null
    });

    // Sequential, not concurrent -- see the note above.
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await mfa.consumeBackupCode(USER_ID, plain));

    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
