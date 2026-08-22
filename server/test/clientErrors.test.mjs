/**
 * The client-error sink.
 *
 * Exists because a page threw on every render for every visitor and the only
 * record of it was inside the affected user's devtools. An operator cannot read
 * that, so the crash was invisible until someone happened to mention it.
 *
 * The tests worth having here are about the endpoint refusing to become a
 * liability: it is unauthenticated by necessity, so it must cap what it accepts
 * and must not trust anything in the body.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');

const SECRET = 'a-test-secret-long-enough-to-pass-the-floor';
const USER = '00000000-0000-4000-8000-000000000001';

const saved = {};
let logged;

function app() {
  const a = express();
  a.use(express.json({ limit: '1mb' }));
  a.use('/api/client-errors', require('../routes/clientErrors.js'));
  return a;
}

beforeEach(() => {
  saved.JWT_SECRET = process.env.JWT_SECRET;
  saved.NODE_ENV = process.env.NODE_ENV;
  saved.SENTRY_DSN = process.env.SENTRY_DSN;
  process.env.JWT_SECRET = SECRET;
  process.env.NODE_ENV = 'test';
  delete process.env.SENTRY_DSN;

  logged = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => { logged.push(args.join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('recording a crash', () => {
  it('REGRESSION: writes the crash to stdout, where the operator can read it', async () => {
    /*
     * The point of the endpoint. reportError alone would not do it -- it returns
     * immediately when SENTRY_DSN is unset, which it is here and in production,
     * so relying on it would rebuild the original problem one layer back: a
     * reporting path that silently discards everything.
     */
    const res = await request(app())
      .post('/api/client-errors')
      .send({ message: 'loading is not defined', route: '/leaderboard', stack: 'at h (Leaderboard.js:1:1)' });

    expect(res.status).toBe(202);

    const line = logged.find(l => l.includes('[client-error]'));
    expect(line, 'nothing reached stdout').toBeTruthy();
    expect(line).toContain('loading is not defined');
    expect(line).toContain('/leaderboard');
  });

  it('returns a reference the user can quote, and logs the same one', async () => {
    const res = await request(app())
      .post('/api/client-errors')
      .send({ message: 'boom' });

    expect(res.body.reference).toMatch(/^[0-9a-f]{8}$/);
    expect(logged.find(l => l.includes('[client-error]'))).toContain(res.body.reference);
  });

  it('accepts a report from a logged-out page', async () => {
    // The boundary wraps Landing and Login. Requiring a session would drop that
    // whole class of crash.
    const res = await request(app()).post('/api/client-errors').send({ message: 'crash before login' });
    expect(res.status).toBe(202);
  });

  it('attaches the user id from the token when there is one', async () => {
    const token = jwt.sign({ id: USER, typ: 'access' }, SECRET, { expiresIn: '1h' });
    await request(app())
      .post('/api/client-errors')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'boom' });

    expect(logged.find(l => l.includes('[client-error]'))).toContain(USER);
  });

  it('REGRESSION: ignores a user id supplied in the body', async () => {
    // A self-reported identity in an error report is worth less than none,
    // because it looks authoritative in the logs.
    await request(app())
      .post('/api/client-errors')
      .send({ message: 'boom', userId: 'attacker-supplied-id' });

    expect(logged.find(l => l.includes('[client-error]'))).not.toContain('attacker-supplied-id');
  });
});

describe('what it refuses', () => {
  it('rejects a report with no message', async () => {
    const res = await request(app()).post('/api/client-errors').send({ stack: 'x' });
    expect(res.status).toBe(400);
  });

  it('REGRESSION: truncates an oversized stack rather than logging all of it', async () => {
    // Unauthenticated: without caps this is a free write-amplification channel
    // into the log pipeline.
    const res = await request(app())
      .post('/api/client-errors')
      .send({ message: 'boom', stack: 'A'.repeat(50000) });

    expect(res.status).toBe(202);
    const line = logged.find(l => l.includes('[client-error]'));
    expect(line).toContain('truncated');
    expect(line.length).toBeLessThan(12000);
  });

  it('REGRESSION: truncates an oversized message too', async () => {
    await request(app()).post('/api/client-errors').send({ message: 'B'.repeat(9000) });
    const line = logged.find(l => l.includes('[client-error]'));
    expect(line).toContain('truncated');
    expect(line.length).toBeLessThan(4000);
  });

  it('does not throw on junk input', async () => {
    const res = await request(app())
      .post('/api/client-errors')
      .send({ message: 'ok', stack: { nested: true }, route: 42, componentStack: null });

    expect(res.status).toBe(202);
  });
});
