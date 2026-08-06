/**
 * sendError and asyncHandler.
 *
 * 72 route handlers were rewritten from a hand-written try/catch onto
 * asyncHandler. The rewrite is only safe if the wrapper reproduces what those
 * catch blocks did exactly: log the real error server-side, return a short
 * message plus a request id to the caller, and never leak the underlying
 * Postgres text. A silent regression here would turn every 500 into either an
 * information leak or an unlogged mystery, and no existing test would notice.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sendError, asyncHandler, isDev } = require('../utils/respond.js');

let logged;
let originalEnv;

beforeEach(() => {
  originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  logged = [];
  vi.spyOn(console, 'error').mockImplementation((line) => logged.push(line));
});

afterEach(() => {
  process.env.NODE_ENV = originalEnv;
  vi.restoreAllMocks();
});

/** A one-route app using the wrapper exactly as the real routers now do. */
function app(handler, message) {
  const a = express();
  a.use(express.json());
  a.get('/x', asyncHandler(handler, message));
  return a;
}

describe('asyncHandler', () => {
  it('routes a rejected promise to sendError', async () => {
    const res = await request(app(async () => {
      throw new Error('relation "users" does not exist');
    }, 'Could not load the thing')).get('/x');

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Could not load the thing');
    expect(res.body.requestId).toBeTruthy();
  });

  it('never leaks the underlying database error to the caller', async () => {
    const res = await request(app(async () => {
      throw new Error('relation "users" does not exist');
    }, 'Could not load the thing')).get('/x');

    // The exact failure the whole respond module exists to prevent: table and
    // column names reaching the browser.
    expect(JSON.stringify(res.body)).not.toMatch(/relation|users|does not exist/);
  });

  it('logs the real error server-side under the same request id', async () => {
    const res = await request(app(async () => {
      throw new Error('relation "users" does not exist');
    }, 'Nope')).get('/x');

    const entry = logged.map((l) => JSON.parse(l)).find((l) => l.level === 'error');
    expect(entry.message).toBe('relation "users" does not exist');
    // Quoting the id from a bug report has to lead to this log line.
    expect(entry.requestId).toBe(res.body.requestId);
  });

  it('catches a synchronous throw too, not only a rejection', async () => {
    const res = await request(app(() => {
      throw new Error('sync boom');
    }, 'Sync message')).get('/x');

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Sync message');
  });

  it('leaves a successful handler completely alone', async () => {
    const res = await request(app(async (req, r) => {
      r.json({ ok: true, value: 42 });
    }, 'unused')).get('/x');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, value: 42 });
    expect(logged).toHaveLength(0);
  });

  it('leaves an explicit non-200 response alone', async () => {
    // Handlers return 400/401/403/404 by returning res.status(...).json(...).
    // Those are not errors and must not be rewritten into a 500.
    const res = await request(app(async (req, r) => {
      r.status(403).json({ message: 'This account has been deactivated' });
    }, 'unused')).get('/x');

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('This account has been deactivated');
  });

  it('falls back to a generic message when none is given', async () => {
    const res = await request(app(async () => { throw new Error('x'); })).get('/x');
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/something went wrong/i);
  });

  it('does not try to respond twice if the handler already sent', async () => {
    const res = await request(app(async (req, r) => {
      r.json({ sent: true });
      throw new Error('too late');
    }, 'Nope')).get('/x');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    // The failure is still recorded even though the response had gone.
    expect(logged.length).toBeGreaterThan(0);
  });
});

describe('setup errors stay readable', () => {
  it('surfaces a missing-migration error verbatim as a 503', async () => {
    // These tell an operator exactly what to run, so hiding them behind a
    // generic string would waste the one message that is actually actionable.
    const res = await request(app(async () => {
      throw new Error(
        'Database schema incomplete: the MFA columns are missing. ' +
        'Run server/db/migrations/010_mfa.sql in the Supabase SQL Editor.'
      );
    }, 'Could not start two-factor setup')).get('/x');

    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/010_mfa\.sql/);
  });
});

describe('development detail', () => {
  it('is withheld unless NODE_ENV is exactly "development"', async () => {
    // isDev is a positive test on purpose: an unset or misspelled NODE_ENV must
    // not start echoing raw Postgres errors back to callers.
    for (const env of ['production', 'test', '', 'developement', undefined]) {
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;

      expect(isDev()).toBe(false);
      const res = await request(app(async () => { throw new Error('secret detail'); }, 'Nope')).get('/x');
      expect(res.body.detail).toBeUndefined();
    }
  });

  it('is included in development, where it is more useful than a generic string', async () => {
    process.env.NODE_ENV = 'development';
    const res = await request(app(async () => { throw new Error('secret detail'); }, 'Nope')).get('/x');
    expect(res.body.detail).toBe('secret detail');
  });
});

describe('sendError directly', () => {
  it('honours an explicit status', async () => {
    const a = express();
    a.get('/x', (req, res) => sendError(res, new Error('nope'), req, 'Not allowed', 403));
    const res = await request(a).get('/x');
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Not allowed');
  });

  it('reuses an inbound x-request-id so a trace spans services', async () => {
    const a = express();
    a.get('/x', (req, res) => sendError(res, new Error('nope'), req, 'Failed'));
    const res = await request(a).get('/x').set('x-request-id', 'abc-123');
    expect(res.body.requestId).toBe('abc-123');
  });
});
