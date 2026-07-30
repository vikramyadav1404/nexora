/**
 * The rest of the Phase 1 hardening: filter injection, the points-transfer
 * race, and the OTP leak. Same createRequire setup as subscriptions.test.mjs —
 * see the comment there for why `import` is not used for server modules.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

process.env.JWT_SECRET = 'test_jwt_secret';

const require = createRequire(import.meta.url);
const { __setTestClient } = require('../db/supabase.js');
const { escapePostgrestValue } = require('../utils/validate.js');
const jwt = require('jsonwebtoken');

const USER = {
  id: '00000000-0000-4000-8000-0000000000aa',
  name: 'Tester',
  email: 'tester@nexora.test',
  points: 100,
  total_answers: 0,
  is_active: true
};
const PEER = {
  id: '00000000-0000-4000-8000-0000000000bb',
  name: 'Peer',
  email: 'peer@nexora.test',
  points: 10,
  total_answers: 0,
  is_active: true
};

let db;
const token = () => jwt.sign({ id: USER.id }, process.env.JWT_SECRET, { expiresIn: '1h' });

beforeEach(() => {
  db = createFakeSupabase({ users: [{ ...USER }, { ...PEER }] });
  __setTestClient(db);
  process.env.NODE_ENV = 'test';
});

describe('escapePostgrestValue', () => {
  it('strips the characters that let a query inject extra filter terms', () => {
    // A comma ends one filter and starts another inside .or(); a dot separates
    // column.operator.value. Either lets a search box rewrite the query.
    expect(escapePostgrestValue('bob,role.eq.admin')).not.toContain(',');
    expect(escapePostgrestValue('bob,role.eq.admin')).not.toContain('.');
    expect(escapePostgrestValue('a(b)c')).not.toMatch(/[()]/);
    expect(escapePostgrestValue('x*y')).not.toContain('*');
  });

  it('strips LIKE wildcards so a lone % cannot match every row', () => {
    expect(escapePostgrestValue('%')).toBe('');
    expect(escapePostgrestValue('a%b_c')).toBe('a b c');
  });

  it('keeps ordinary queries usable', () => {
    expect(escapePostgrestValue('  react hooks  ')).toBe('react hooks');
    expect(escapePostgrestValue('José')).toBe('José');
  });

  it('caps length', () => {
    expect(escapePostgrestValue('a'.repeat(500)).length).toBeLessThanOrEqual(80);
  });

  it('handles null and undefined', () => {
    expect(escapePostgrestValue(null)).toBe('');
    expect(escapePostgrestValue(undefined)).toBe('');
  });
});

describe('POST /api/rewards/transfer', () => {
  function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/rewards', require('../routes/rewards.js'));
    return a;
  }

  const send = (body) =>
    request(app())
      .post('/api/rewards/transfer')
      .set('Authorization', `Bearer ${token()}`)
      .send(body);

  it('moves points through the atomic RPC', async () => {
    const res = await send({ toUserId: PEER.id, points: 50 });

    expect(res.status).toBe(200);
    expect(db._tables.users.find(u => u.id === USER.id).points).toBe(50);
    expect(db._tables.users.find(u => u.id === PEER.id).points).toBe(60);
  });

  it('enforces the 10-point floor inside the transfer, not just in the pre-check', async () => {
    // 100 - 95 = 5, below the floor. The RPC must refuse even though the
    // route's friendly pre-check would also catch this.
    const res = await send({ toUserId: PEER.id, points: 95 });

    expect(res.status).toBe(400);
    expect(db._tables.users.find(u => u.id === USER.id).points).toBe(100);
  });

  it('REGRESSION: concurrent transfers cannot double-spend', async () => {
    // Old code read both balances, then wrote both — so N parallel requests all
    // read 100 and each wrote 100-60, letting one user spend the same points
    // repeatedly. The RPC re-checks under a row lock, so only the affordable
    // transfers can land.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => send({ toUserId: PEER.id, points: 60 }))
    );

    const ok = results.filter(r => r.status === 200);
    const sender = db._tables.users.find(u => u.id === USER.id);
    const peer = db._tables.users.find(u => u.id === PEER.id);

    expect(ok.length).toBe(1);                 // only one 60 is affordable from 100
    expect(sender.points).toBe(40);
    expect(peer.points).toBe(70);
    expect(sender.points).toBeGreaterThanOrEqual(10);
    // Points are conserved: nothing was created out of thin air.
    expect(sender.points + peer.points).toBe(USER.points + PEER.points);
  });

  it('refuses a transfer to yourself', async () => {
    const res = await send({ toUserId: USER.id, points: 20 });
    expect(res.status).toBe(400);
    expect(db._tables.users.find(u => u.id === USER.id).points).toBe(100);
  });

  it('rejects a non-uuid recipient', async () => {
    const res = await send({ toUserId: 'not-a-uuid', points: 20 });
    expect(res.status).toBe(400);
  });
});

describe('error responses', () => {
  it('does not leak raw database errors to the client in production', async () => {
    process.env.NODE_ENV = 'production';
    const { sendError } = require('../utils/respond.js');

    let status; let payload;
    const res = {
      headersSent: false,
      status(s) { status = s; return this; },
      json(p) { payload = p; return this; }
    };

    sendError(
      res,
      new Error('relation "users" does not exist, column password'),
      { method: 'GET', originalUrl: '/api/x', headers: {} },
      'Could not load that'
    );

    expect(status).toBe(500);
    expect(payload.message).toBe('Could not load that');
    expect(JSON.stringify(payload)).not.toMatch(/relation|column|password/);
    expect(payload.requestId).toBeTruthy();
  });

  it('still surfaces setup errors, which tell the operator what to run', async () => {
    process.env.NODE_ENV = 'production';
    const { sendError } = require('../utils/respond.js');

    let status; let payload;
    const res = {
      headersSent: false,
      status(s) { status = s; return this; },
      json(p) { payload = p; return this; }
    };

    sendError(res, new Error('Database schema incomplete. Run server/db/migrations/001_setup_step_a.sql'), {
      method: 'POST', originalUrl: '/api/posts', headers: {}
    });

    expect(status).toBe(503);
    expect(payload.message).toMatch(/001_setup_step_a/);
  });
});
