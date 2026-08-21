/**
 * Two landmines and one reachable hole.
 *
 * None of these was exploitable the day it was found, which is exactly why they
 * survived: each one needs a second thing to go wrong before it bites, and
 * nothing fails in the meantime.
 *
 *   JWT_SECRET fell back to 'dev_insecure_jwt' -- a string published in this
 *   repository -- in the function that SIGNS tokens. Protected routes failed
 *   closed on a missing secret, so the symptom would have been 500s, while
 *   /login quietly issued sessions anyone could forge for any user id.
 *
 *   logout-all verified its own bearer token by hand and accepted
 *   typ: 'mfa_pending' -- a token proving only that the password was right.
 *   Someone with a stolen password, stopped by the second factor, could still
 *   log the victim out of every session, repeatedly.
 *
 * The second is the argument for the first fix in this file: the check existed
 * and was correct in `protect`, and a copy elsewhere omitted it. One
 * implementation, or it drifts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createRequire } from 'node:module';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

const require = createRequire(import.meta.url);
const { __setTestClient } = require('../db/supabase.js');
const { verifyAccessToken } = require('../middleware/auth.js');
const { assertJwtSecret, MIN_JWT_SECRET_LENGTH } = require('../utils/tokens.js');
const jwt = require('jsonwebtoken');

const SECRET = 'a-test-secret-long-enough-to-pass-the-floor';
const USER_ID = '00000000-0000-4000-8000-000000000001';

let db;
const saved = {};

function app() {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use('/api/auth', require('../routes/auth.js'));
  return a;
}

const sign = (payload, secret = SECRET) => jwt.sign(payload, secret, { expiresIn: '1h' });

beforeEach(() => {
  saved.JWT_SECRET = process.env.JWT_SECRET;
  saved.NODE_ENV = process.env.NODE_ENV;
  process.env.JWT_SECRET = SECRET;
  process.env.NODE_ENV = 'test';

  db = createFakeSupabase({
    users: [{ id: USER_ID, name: 'Victim', email: 'v@nexora.test', is_active: true, points: 0 }],
    refresh_tokens: [
      { id: 'rt1', user_id: USER_ID, token_hash: 'h1', revoked_at: null, expires_at: new Date(Date.now() + 86400000).toISOString() },
      { id: 'rt2', user_id: USER_ID, token_hash: 'h2', revoked_at: null, expires_at: new Date(Date.now() + 86400000).toISOString() }
    ]
  });
  __setTestClient(db);
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const liveTokens = () => db._tables.refresh_tokens.filter(t => !t.revoked_at).length;

describe('JWT_SECRET has no fallback', () => {
  it('REGRESSION: signing throws rather than using a known string', () => {
    delete process.env.JWT_SECRET;
    const { signAccessToken } = require('../utils/tokens.js');

    // The old behaviour returned a token signed with 'dev_insecure_jwt', which
    // is in this repository and forgeable by anyone who read it.
    expect(() => signAccessToken(USER_ID)).toThrow(/JWT_SECRET/);
  });

  it('REGRESSION: boot refuses when the secret is missing', () => {
    expect(() => assertJwtSecret({})).toThrow(/refusing to start/i);
  });

  it('REGRESSION: boot refuses a secret short enough to be a placeholder', () => {
    expect(() => assertJwtSecret({ JWT_SECRET: 'short' })).toThrow(/at least/i);
    expect(() => assertJwtSecret({ JWT_SECRET: 'x'.repeat(MIN_JWT_SECRET_LENGTH - 1) })).toThrow();
  });

  it('boot proceeds with a real secret', () => {
    expect(() => assertJwtSecret({ JWT_SECRET: 'x'.repeat(MIN_JWT_SECRET_LENGTH) })).not.toThrow();
  });
});

describe('verifyAccessToken is the single source of truth', () => {
  it('accepts a genuine access token', () => {
    const r = verifyAccessToken(sign({ id: USER_ID, typ: 'access' }));
    expect(r.ok).toBe(true);
    expect(r.decoded.id).toBe(USER_ID);
  });

  it('REGRESSION: refuses a half-authenticated mfa_pending token', () => {
    const r = verifyAccessToken(sign({ id: USER_ID, typ: 'mfa_pending' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('mfa_pending');
  });

  it('REGRESSION: refuses a token signed with the old hardcoded secret', () => {
    // The exact forgery the fallback made possible.
    const forged = jwt.sign({ id: USER_ID, typ: 'access' }, 'dev_insecure_jwt', { expiresIn: '1h' });
    expect(verifyAccessToken(forged).ok).toBe(false);
  });

  it('REGRESSION: refuses everything when the secret is absent', () => {
    delete process.env.JWT_SECRET;
    const r = verifyAccessToken(sign({ id: USER_ID, typ: 'access' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('misconfigured');
  });

  it('refuses a missing or malformed token', () => {
    expect(verifyAccessToken(null).ok).toBe(false);
    expect(verifyAccessToken('not-a-jwt').ok).toBe(false);
  });

  it('treats an absent typ as an access token', () => {
    // Tokens issued before the claim existed must keep working.
    expect(verifyAccessToken(sign({ id: USER_ID })).ok).toBe(true);
  });
});

describe('logout-all cannot be driven by a half-authenticated token', () => {
  const logoutAll = (token) =>
    request(app()).post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .send({ all: true });

  it('REGRESSION: an mfa_pending token revokes nothing', async () => {
    expect(liveTokens()).toBe(2);

    const res = await logoutAll(sign({ id: USER_ID, typ: 'mfa_pending' }));

    expect(res.status).toBe(401);
    // Asserted on the store, not the status: the bug was that it revoked.
    expect(liveTokens()).toBe(2);
  });

  it('REGRESSION: a token forged with the old hardcoded secret revokes nothing', async () => {
    const forged = jwt.sign({ id: USER_ID, typ: 'access' }, 'dev_insecure_jwt', { expiresIn: '1h' });

    const res = await logoutAll(forged);

    expect(res.status).toBe(401);
    expect(liveTokens()).toBe(2);
  });

  it('a real access token still revokes every session', async () => {
    const res = await logoutAll(sign({ id: USER_ID, typ: 'access' }));

    expect(res.status).toBe(200);
    expect(liveTokens()).toBe(0);
  });
});

describe('CORS is an exact allowlist, not a pattern', () => {
  /*
   * The old rule allowed any origin ending .vercel.app, with credentials: true.
   * Anyone can deploy there. Confirmed against production before changing it:
   * a request claiming Origin: https://totally-unrelated-attacker.vercel.app
   * came back with that exact value in Access-Control-Allow-Origin.
   */
  const { isAllowedOrigin } = require('../utils/corsOrigins.js');

  const PROD = {
    NODE_ENV: 'production',
    CLIENT_URL: 'https://app.example.com',
    CORS_EXTRA_ORIGINS: 'https://preview.example.com'
  };

  it('allows the configured client origin', () => {
    expect(isAllowedOrigin('https://app.example.com', PROD)).toBe(true);
  });

  it('allows an explicitly listed extra origin', () => {
    expect(isAllowedOrigin('https://preview.example.com', PROD)).toBe(true);
  });

  it('REGRESSION: refuses an arbitrary .vercel.app origin', () => {
    expect(isAllowedOrigin('https://totally-unrelated-attacker.vercel.app', PROD)).toBe(false);
    // Including one that looks plausibly related -- the pattern could not tell
    // these apart, which was the whole problem.
    expect(isAllowedOrigin('https://nexora-api-beta.vercel.app', PROD)).toBe(false);
  });

  it('REGRESSION: refuses localhost in production', () => {
    expect(isAllowedOrigin('http://localhost:5173', PROD)).toBe(false);
    expect(isAllowedOrigin('http://127.0.0.1:5173', PROD)).toBe(false);
  });

  it('allows localhost in development, where it is the point', () => {
    const dev = { ...PROD, NODE_ENV: 'development' };
    expect(isAllowedOrigin('http://localhost:5173', dev)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:3000', dev)).toBe(true);
  });

  it('REGRESSION: the localhost pattern is anchored', () => {
    // localhost.evil.com and evil.com/?x=http://localhost must not match.
    const dev = { ...PROD, NODE_ENV: 'development' };
    expect(isAllowedOrigin('http://localhost.evil.com', dev)).toBe(false);
    expect(isAllowedOrigin('https://evil.com#http://localhost', dev)).toBe(false);
  });

  it('refuses an unrelated origin outright', () => {
    expect(isAllowedOrigin('https://evil.example.com', PROD)).toBe(false);
  });

  it('permits a request with no Origin header', () => {
    // curl, server-to-server, same-origin. Not a CORS decision at all.
    expect(isAllowedOrigin(undefined, PROD)).toBe(true);
    expect(isAllowedOrigin('', PROD)).toBe(true);
  });
});
