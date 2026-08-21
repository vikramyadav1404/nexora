/**
 * Development aids must not leak when NODE_ENV is anything but 'development'.
 *
 * These gates were written as `NODE_ENV !== 'production'`, which fails open: an
 * unset, empty, or misspelled value satisfies it. A deployment missing that one
 * dashboard variable would hand plaintext passwords, OTPs and stack traces to
 * unauthenticated callers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
const { isDev } = require('../utils/respond.js');
const bcrypt = require('bcryptjs');

const USER = {
  id: '00000000-0000-4000-8000-0000000000aa',
  name: 'Tester',
  email: 'tester@nexora.test',
  phone: '',
  is_active: true,
  points: 0,
  forgot_password_count_today: 0,
  last_forgot_password_date: null
};

let db;
const originalEnv = process.env.NODE_ENV;

function app() {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use('/api/auth', require('../routes/auth.js'));
  return a;
}

const forgot = (email) =>
  request(app()).post('/api/auth/forgot-password').send({ email });

beforeEach(async () => {
  db = createFakeSupabase({
    users: [{ ...USER, password: await bcrypt.hash('old-password', fixtureCost()) }],
    refresh_tokens: []
  });
  __setTestClient(db);
});

afterEach(() => {
  process.env.NODE_ENV = originalEnv;
});

describe('isDev() fails closed', () => {
  it('is false when NODE_ENV is unset', () => {
    delete process.env.NODE_ENV;
    expect(isDev()).toBe(false);
  });

  it.each(['', 'production', 'prod', 'Production', 'staging', 'test', 'developement'])(
    'is false for NODE_ENV=%o',
    (value) => {
      process.env.NODE_ENV = value;
      expect(isDev()).toBe(false);
    }
  );

  it('is true only for exactly "development"', () => {
    process.env.NODE_ENV = 'development';
    expect(isDev()).toBe(true);
  });
});

describe('POST /api/auth/forgot-password does not leak the password', () => {
  it('returns no devPassword when NODE_ENV is unset', async () => {
    delete process.env.NODE_ENV;

    const res = await forgot(USER.email);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('devPassword');
    // And nothing password-shaped smuggled in under another key.
    expect(JSON.stringify(res.body)).not.toMatch(/[A-Za-z0-9]{10}/);
  });

  it.each(['', 'production', 'staging', 'Development'])(
    'returns no devPassword when NODE_ENV=%o',
    async (value) => {
      process.env.NODE_ENV = value;
      const res = await forgot(USER.email);
      expect(res.body).not.toHaveProperty('devPassword');
    }
  );

  it('still resets the password even though it is not echoed', async () => {
    delete process.env.NODE_ENV;
    const before = db._tables.users[0].password;

    await forgot(USER.email);

    expect(db._tables.users[0].password).not.toBe(before);
  });

  it('exposes devPassword only under an explicit development env', async () => {
    process.env.NODE_ENV = 'development';
    const res = await forgot(USER.email);
    expect(res.body).toHaveProperty('devPassword');
  });
});

describe('POST /api/auth/forgot-password does not enumerate users', () => {
  beforeEach(() => { delete process.env.NODE_ENV; });

  it('answers identically for a registered and an unregistered email', async () => {
    const known = await forgot(USER.email);
    const unknown = await forgot('nobody-here@nexora.test');

    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
    expect(known.status).toBe(200);
  });

  it('answers identically when the daily cap is already spent', async () => {
    // First reset consumes the allowance.
    await forgot(USER.email);
    const second = await forgot(USER.email);
    const unknown = await forgot('nobody-here@nexora.test');

    // Previously a 429 here, which confirmed the account exists.
    expect(second.status).toBe(unknown.status);
    expect(second.body).toEqual(unknown.body);
  });

  it('enforces the daily cap despite the identical reply', async () => {
    await forgot(USER.email);
    const afterFirst = db._tables.users[0].password;

    await forgot(USER.email);

    // Second request changed nothing — the cap held.
    expect(db._tables.users[0].password).toBe(afterFirst);
    expect(db._tables.users[0].forgot_password_count_today).toBe(1);
  });

  it('never names the account in the response', async () => {
    const res = await forgot(USER.email);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(USER.email);
    expect(body).not.toContain(USER.name);
    expect(body).not.toMatch(/not found/i);
  });
});
