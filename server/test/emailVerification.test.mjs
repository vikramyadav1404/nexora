/**
 * The email-verification gate.
 *
 * users.email_verified was set at registration and enforced nowhere -- one
 * consumer in the whole codebase, the weekly digest filter. Making it mean
 * something needed the backfill first (migration 018): 29 accounts, 1 verified,
 * 28 not, so a gate without grandfathering was a 96% lockout.
 *
 * These assert BOTH directions on every route. A gate that refuses everything
 * passes a one-sided test perfectly, and "nobody can transfer points" is a worse
 * bug than the one being fixed -- it just fails in a direction that looks
 * secure.
 *
 * The list is deliberate, and the exclusions are as considered as the
 * inclusions: posting and questions are the product and already bounded by
 * daily quotas; payments are revenue; blocking is self-protective and must work
 * whatever state an account is in.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

const require = createRequire(import.meta.url);
const { __setTestClient } = require('../db/supabase.js');
const { requireVerifiedEmail } = require('../middleware/requireVerifiedEmail.js');
const jwt = require('jsonwebtoken');

const SECRET = 'a-test-secret-long-enough-to-pass-the-floor';
const VERIFIED = '00000000-0000-4000-8000-00000000000a';
const UNVERIFIED = '00000000-0000-4000-8000-00000000000b';

let db;
const saved = {};

function user(id, verified) {
  return {
    id,
    name: verified ? 'Verified' : 'Unverified',
    email: `${id}@nexora.test`,
    email_verified: verified,
    is_active: true,
    points: 500,
    total_answers: 20,
    interests: ['technology']
  };
}

const token = (id) => jwt.sign({ id, typ: 'access' }, SECRET, { expiresIn: '1h' });

function app(mountPath, routerPath) {
  const a = express();
  a.use(express.json());
  a.use(mountPath, require(routerPath));
  return a;
}

beforeEach(() => {
  saved.JWT_SECRET = process.env.JWT_SECRET;
  saved.NODE_ENV = process.env.NODE_ENV;
  saved.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  process.env.JWT_SECRET = SECRET;
  process.env.NODE_ENV = 'test';

  db = createFakeSupabase({
    users: [user(VERIFIED, true), user(UNVERIFIED, false)],
    reports: [], point_transfers: [], blocks: []
  });
  __setTestClient(db);
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('the middleware itself', () => {
  const run = (userRow) => {
    const res = {
      statusCode: null, body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; }
    };
    let called = false;
    requireVerifiedEmail({ userRow }, res, () => { called = true; });
    return { res, called };
  };

  it('lets a verified user through', () => {
    const { called, res } = run({ email_verified: true });
    expect(called).toBe(true);
    expect(res.statusCode).toBeNull();
  });

  it('REGRESSION: refuses an unverified user with a flag the client can act on', () => {
    const { called, res } = run({ email_verified: false });

    expect(called).toBe(false);
    expect(res.statusCode).toBe(403);
    // "You cannot do this yet" and "this failed" must not look the same.
    expect(res.body.emailVerificationRequired).toBe(true);
  });

  it('REGRESSION: treats a missing flag as unverified, not as permission', () => {
    // An absent column must not read as consent.
    expect(run({}).called).toBe(false);
    expect(run({ email_verified: null }).called).toBe(false);
    expect(run({ email_verified: 'true' }).called).toBe(false);
  });

  it('REGRESSION: fails closed when mounted without protect', () => {
    // No req.userRow means protect did not run. A permission middleware that
    // passes everything because it was mounted wrong is the worst outcome.
    const { called, res } = run(undefined);
    expect(called).toBe(false);
    expect(res.statusCode).toBe(500);
  });
});

describe('point transfers', () => {
  const transfer = (as) =>
    request(app('/api/rewards', '../routes/rewards.js'))
      .post('/api/rewards/transfer')
      .set('Authorization', `Bearer ${token(as)}`)
      .send({ toUserId: VERIFIED, points: 10 });

  it('REGRESSION: an unverified account cannot transfer points', async () => {
    const res = await transfer(UNVERIFIED);

    expect(res.status).toBe(403);
    expect(res.body.emailVerificationRequired).toBe(true);
    expect(db._tables.point_transfers).toHaveLength(0);
  });

  it('a verified account is not blocked by the gate', async () => {
    // The other direction. It may fail later for its own reasons -- balance
    // floors, self-transfer -- but it must not fail at the gate.
    const res = await transfer(VERIFIED);
    expect(res.status).not.toBe(403);
  });
});

describe('reports', () => {
  const report = (as) =>
    request(app('/api', '../routes/safety.js'))
      .post('/api/reports')
      .set('Authorization', `Bearer ${token(as)}`)
      .send({ targetType: 'post', targetId: 'p1', reason: 'spam' });

  it('REGRESSION: an unverified account cannot file a report', async () => {
    const res = await report(UNVERIFIED);
    expect(res.status).toBe(403);
    expect(res.body.emailVerificationRequired).toBe(true);
  });

  it('a verified account can', async () => {
    const res = await report(VERIFIED);
    expect(res.status).not.toBe(403);
  });
});

describe('blocking stays open to everyone', () => {
  it('REGRESSION: an unverified account can still block someone', async () => {
    /*
     * Deliberately ungated, and this test exists to stop it being swept in
     * later by someone tidying. Blocking is self-protective: whatever we think
     * of an account's email address, it must always be able to protect itself
     * from another user. Gating it would mean the people most likely to be
     * harassed -- new accounts -- are the ones who cannot stop it.
     */
    const res = await request(app('/api', '../routes/safety.js'))
      .post(`/api/blocks/${VERIFIED}`)
      .set('Authorization', `Bearer ${token(UNVERIFIED)}`)
      .send({});

    expect(res.status).not.toBe(403);
  });
});

describe('the AI routes', () => {
  const draft = (as) =>
    request(app('/api/ai', '../routes/ai.js'))
      .post('/api/ai/suggest-tags')
      .set('Authorization', `Bearer ${token(as)}`)
      .send({ title: 'A question', body: 'Some detail' });

  it('REGRESSION: an unverified account cannot spend Opus tokens', async () => {
    // The only gated route that costs actual money per call.
    const res = await draft(UNVERIFIED);

    expect(res.status).toBe(403);
    expect(res.body.emailVerificationRequired).toBe(true);
  });

  it('a verified account is not blocked by the gate', async () => {
    const res = await draft(VERIFIED);
    // Will fail on the missing Anthropic key, which is fine -- it must not be
    // the gate that stops it.
    expect(res.status).not.toBe(403);
  });
});
