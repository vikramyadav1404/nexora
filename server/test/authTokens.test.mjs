/**
 * Access/refresh token lifetime, rotation and reuse detection.
 *
 * Same createRequire setup as the other suites — see subscriptions.test.mjs for
 * why `import` is not used for server modules.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createRequire } from 'node:module';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

process.env.JWT_SECRET = 'test_jwt_secret';

const require = createRequire(import.meta.url);
// Fixture hashes track the same cost knob as the source; see utils/bcryptCost.js.
const { fixtureCost } = require('../utils/bcryptCost.js');
const { __setTestClient } = require('../db/supabase.js');
const tokens = require('../utils/tokens.js');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const USER = {
  id: '00000000-0000-4000-8000-0000000000aa',
  name: 'Tester',
  email: 'tester@nexora.test',
  is_active: true,
  points: 0
};

let db;

function app() {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use('/api/auth', require('../routes/auth.js'));
  a.use('/api/users', require('../routes/users.js'));
  return a;
}

/** Pull the refresh cookie value out of a supertest response. */
function refreshCookieFrom(res) {
  const raw = res.headers['set-cookie'] || [];
  const line = raw.find(c => c.startsWith(`${tokens.REFRESH_COOKIE}=`));
  return line ? line.split(';')[0].split('=').slice(1).join('=') : null;
}
function cookieAttrs(res) {
  const raw = res.headers['set-cookie'] || [];
  return raw.find(c => c.startsWith(`${tokens.REFRESH_COOKIE}=`)) || '';
}

beforeEach(async () => {
  db = createFakeSupabase({
    users: [{ ...USER, password: await bcrypt.hash('correct-horse', fixtureCost()) }],
    refresh_tokens: []
  });
  __setTestClient(db);
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('access token', () => {
  it('expires in 15 minutes, not 7 days', async () => {
    const { accessToken } = await tokens.issueSession(USER.id);
    const { iat, exp, typ } = jwt.decode(accessToken);

    expect(exp - iat).toBe(15 * 60);
    expect(typ).toBe('access');
  });

  it('is rejected by a protected route once expired', async () => {
    const expired = jwt.sign({ id: USER.id, typ: 'access' }, process.env.JWT_SECRET, { expiresIn: '-1s' });
    const res = await request(app()).get('/api/auth/me').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it('a token with a non-access typ is refused everywhere', async () => {
    // Part B issues typ: 'mfa_pending'. The middleware must reject it now, so
    // adding MFA later cannot accidentally grant access with a half-auth token.
    const pending = jwt.sign({ id: USER.id, typ: 'mfa_pending' }, process.env.JWT_SECRET, { expiresIn: '5m' });

    const me = await request(app()).get('/api/auth/me').set('Authorization', `Bearer ${pending}`);
    expect(me.status).toBe(401);
    expect(me.body.message).toMatch(/additional verification/i);

    const other = await request(app()).get('/api/users/me/requests').set('Authorization', `Bearer ${pending}`);
    expect(other.status).toBe(401);
  });
});

describe('login issues a refresh cookie', () => {
  const login = () =>
    request(app()).post('/api/auth/login').send({ email: USER.email, password: 'correct-horse' });

  it('returns an access token in the body and a refresh cookie', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect(jwt.decode(res.body.token).typ).toBe('access');
    expect(refreshCookieFrom(res)).toBeTruthy();
  });

  it('the cookie is httpOnly, SameSite=Strict and scoped to /api/auth', async () => {
    const attrs = cookieAttrs(await login());
    expect(attrs).toMatch(/HttpOnly/i);
    expect(attrs).toMatch(/SameSite=Strict/i);
    expect(attrs).toMatch(/Path=\/api\/auth/i);
  });

  it('stores only a hash of the refresh token, never the token', async () => {
    const res = await login();
    const raw = refreshCookieFrom(res);
    const rows = db._tables.refresh_tokens;

    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(raw);
    expect(rows[0].token_hash).toBe(tokens.hashToken(raw));
    // The plaintext appears nowhere in the row.
    expect(JSON.stringify(rows[0])).not.toContain(raw);
  });
});

describe('POST /api/auth/refresh', () => {
  it('rotates: old token revoked, new one issued, chain recorded', async () => {
    const first = await tokens.issueSession(USER.id);

    const res = await request(app())
      .post('/api/auth/refresh')
      .set('Cookie', `${tokens.REFRESH_COOKIE}=${first.refreshToken}`);

    expect(res.status).toBe(200);
    expect(jwt.decode(res.body.token).typ).toBe('access');

    const next = refreshCookieFrom(res);
    expect(next).toBeTruthy();
    expect(next).not.toBe(first.refreshToken);

    const rows = db._tables.refresh_tokens;
    const old = rows.find(r => r.token_hash === tokens.hashToken(first.refreshToken));
    const created = rows.find(r => r.token_hash === tokens.hashToken(next));

    expect(old.revoked_at).toBeTruthy();
    expect(old.replaced_by).toBe(created.id);
    expect(created.revoked_at).toBeFalsy();
  });

  it('rejects a request with no cookie', async () => {
    const res = await request(app()).post('/api/auth/refresh');
    expect(res.status).toBe(401);
  });

  it('rejects an unknown token', async () => {
    const res = await request(app())
      .post('/api/auth/refresh')
      .set('Cookie', `${tokens.REFRESH_COOKIE}=not-a-real-token`);
    expect(res.status).toBe(401);
  });

  it('rejects an expired token without revoking anything', async () => {
    const session = await tokens.issueSession(USER.id);
    const row = db._tables.refresh_tokens[0];
    row.expires_at = new Date(Date.now() - 1000).toISOString();

    const res = await request(app())
      .post('/api/auth/refresh')
      .set('Cookie', `${tokens.REFRESH_COOKIE}=${session.refreshToken}`);

    expect(res.status).toBe(401);
    expect(row.revoked_at).toBeFalsy();
  });
});

describe('reuse detection', () => {
  it('replaying a rotated token revokes the entire family', async () => {
    // Legitimate client: log in, then rotate twice.
    const first = await tokens.issueSession(USER.id);
    const r1 = await request(app())
      .post('/api/auth/refresh')
      .set('Cookie', `${tokens.REFRESH_COOKIE}=${first.refreshToken}`);
    const second = refreshCookieFrom(r1);

    const r2 = await request(app())
      .post('/api/auth/refresh')
      .set('Cookie', `${tokens.REFRESH_COOKIE}=${second}`);
    const third = refreshCookieFrom(r2);
    expect(r2.status).toBe(200);

    // An attacker replays the first token, which was rotated away two steps ago.
    const replay = await request(app())
      .post('/api/auth/refresh')
      .set('Cookie', `${tokens.REFRESH_COOKIE}=${first.refreshToken}`);

    expect(replay.status).toBe(401);
    expect(replay.body.message).toMatch(/security/i);

    // Everything is dead, including the token the honest client currently holds.
    const live = db._tables.refresh_tokens.filter(r => !r.revoked_at);
    expect(live).toHaveLength(0);

    const afterwards = await request(app())
      .post('/api/auth/refresh')
      .set('Cookie', `${tokens.REFRESH_COOKIE}=${third}`);
    expect(afterwards.status).toBe(401);
  });

  it('clears the cookie so the client stops retrying', async () => {
    const session = await tokens.issueSession(USER.id);
    await tokens.revokeRefreshToken(session.refreshToken);

    const res = await request(app())
      .post('/api/auth/refresh')
      .set('Cookie', `${tokens.REFRESH_COOKIE}=${session.refreshToken}`);

    expect(res.status).toBe(401);
    const cleared = (res.headers['set-cookie'] || []).find(c => c.startsWith(tokens.REFRESH_COOKIE));
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);
  });
});

describe('logout', () => {
  it('revokes the presented token only', async () => {
    const a = await tokens.issueSession(USER.id);
    const b = await tokens.issueSession(USER.id);

    const res = await request(app())
      .post('/api/auth/logout')
      .set('Cookie', `${tokens.REFRESH_COOKIE}=${a.refreshToken}`);
    expect(res.status).toBe(200);

    const rows = db._tables.refresh_tokens;
    expect(rows.find(r => r.token_hash === tokens.hashToken(a.refreshToken)).revoked_at).toBeTruthy();
    expect(rows.find(r => r.token_hash === tokens.hashToken(b.refreshToken)).revoked_at).toBeFalsy();
  });

  it('all:true revokes every session for the user', async () => {
    const a = await tokens.issueSession(USER.id);
    await tokens.issueSession(USER.id);

    const res = await request(app())
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ all: true });

    expect(res.status).toBe(200);
    expect(db._tables.refresh_tokens.filter(r => !r.revoked_at)).toHaveLength(0);
  });
});

describe('password change ends other sessions', () => {
  it('revokes every existing token and re-issues a working one for the caller', async () => {
    const a = await tokens.issueSession(USER.id);
    const b = await tokens.issueSession(USER.id);

    const res = await request(app())
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ currentPassword: 'correct-horse', newPassword: 'new-password-1' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();

    // Both pre-existing tokens are revoked in the store.
    const rows = db._tables.refresh_tokens;
    expect(rows.find(r => r.token_hash === tokens.hashToken(a.refreshToken)).revoked_at).toBeTruthy();
    expect(rows.find(r => r.token_hash === tokens.hashToken(b.refreshToken)).revoked_at).toBeTruthy();

    // The caller's replacement works.
    const fresh = refreshCookieFrom(res);
    const ok = await request(app())
      .post('/api/auth/refresh')
      .set('Cookie', `${tokens.REFRESH_COOKIE}=${fresh}`);
    expect(ok.status).toBe(200);
  });

  it('a stale token presented afterwards is treated as reuse and ends the new session too', async () => {
    /*
     * Documents a consequence of the spec, not a bug.
     *
     * "If an already-revoked token is presented, revoke the entire family" does
     * not distinguish why the token was revoked. A tab left open from before a
     * password change will eventually retry with its old token, which looks
     * identical to theft from the server's side — so the fresh session dies too
     * and the user is logged out a second time.
     *
     * Pinning it here so the behaviour is a decision rather than a surprise.
     */
    const old = await tokens.issueSession(USER.id);

    const changed = await request(app())
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${old.accessToken}`)
      .send({ currentPassword: 'correct-horse', newPassword: 'new-password-1' });
    const fresh = refreshCookieFrom(changed);

    // The stale tab retries.
    const stale = await request(app())
      .post('/api/auth/refresh')
      .set('Cookie', `${tokens.REFRESH_COOKIE}=${old.refreshToken}`);
    expect(stale.status).toBe(401);
    expect(stale.body.message).toMatch(/security/i);

    // Collateral: the session created by the password change is gone as well.
    const after = await request(app())
      .post('/api/auth/refresh')
      .set('Cookie', `${tokens.REFRESH_COOKIE}=${fresh}`);
    expect(after.status).toBe(401);
  });
});
