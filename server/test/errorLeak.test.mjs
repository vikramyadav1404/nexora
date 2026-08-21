/**
 * Express's error path must not echo database text.
 *
 * The global handler returned `err.message` verbatim. For a PostgREST or
 * Postgres failure that is raw database detail -- table names, column names,
 * constraint names -- handed to whoever triggered the error.
 *
 * The tempting reading was that it could not be reached: asyncHandler routes
 * everything through sendError, which already decides what is safe. But
 * fifteen real routes are not wrapped in asyncHandler and land here -- all five
 * of ai.js, all four of cron.js, five in users.js, three in auth.js, two in
 * subscriptions.js, one in posts.js.
 *
 * So these tests use an UNWRAPPED route deliberately. A test that went through
 * asyncHandler would pass with the global handler still leaking, which is
 * exactly the partial coverage that produced the bug.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sendError } = require('../utils/respond.js');

const saved = {};

beforeEach(() => {
  saved.NODE_ENV = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
});

afterEach(() => {
  if (saved.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = saved.NODE_ENV;
});

/**
 * The shape index.js mounts: a route that does NOT use asyncHandler, throwing
 * into Express's error path, with the same handler index.js installs.
 */
function app(err) {
  const a = express();
  a.use(express.json());

  // No asyncHandler. This is how ai.js and cron.js are written.
  a.get('/api/unwrapped', (req, res, next) => next(err));

  a.use((e, req, res, _next) => {
    const status = e.status || e.statusCode || 500;
    sendError(res, e, req, 'Something went wrong on our end', status);
  });
  return a;
}

/** A PostgREST error, in the shape supabase-js actually produces. */
function postgrestError() {
  const e = new Error(
    'column users.mfa_secret does not exist'
  );
  e.code = '42703';
  e.details = 'relation "public.refresh_tokens" has no column "token_hash"';
  e.hint = 'Perhaps you meant to reference the column "users.mfa_enabled".';
  return e;
}

describe('an unwrapped route that throws', () => {
  it('REGRESSION: does not echo the database message', async () => {
    const res = await request(app(postgrestError())).get('/api/unwrapped');

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('mfa_secret');
    expect(body).not.toContain('refresh_tokens');
    expect(body).not.toContain('token_hash');
    expect(body).not.toContain('42703');
    expect(body).not.toContain('does not exist');
  });

  it('REGRESSION: leaks no table or column name from details or hint either', async () => {
    // supabase-js splits the useful detail across three fields. Sanitising only
    // `message` would still hand over the schema.
    const res = await request(app(postgrestError())).get('/api/unwrapped');

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('mfa_enabled');
    expect(body).not.toContain('public.');
  });

  it('still gives the caller something to quote', async () => {
    // Generic is not the same as useless. A requestId ties the response to the
    // full error in the logs, which is where the detail belongs.
    const res = await request(app(postgrestError())).get('/api/unwrapped');

    expect(res.status).toBe(500);
    expect(res.body.requestId).toBeTruthy();
    expect(res.body.message).toBeTruthy();
  });

  it('REGRESSION: no stack trace in production', async () => {
    const res = await request(app(postgrestError())).get('/api/unwrapped');
    expect(res.body.stack).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('at ');
  });
});

describe('what must still get through', () => {
  it('a setup error keeps its message, because it tells the operator what to fix', async () => {
    /*
     * isSafeSetupError exists so an unapplied migration says so rather than
     * becoming a generic 500 nobody can act on. Sanitising everything would
     * have removed that, so this asserts the exception survived rather than
     * assuming it. PGRST204 is a missing column -- the code the function
     * actually recognises.
     */
    const e = new Error('Could not find the table \'public.users\' in the schema cache');
    e.code = 'PGRST204';

    const res = await request(app(e)).get('/api/unwrapped');

    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/schema cache/i);
  });


  it('PGRST205 is deliberately NOT on the safe list', async () => {
    /*
     * A missing table is arguably as actionable as a missing column, and I
     * nearly widened isSafeSetupError to include it while writing this. Left
     * alone on purpose: PGRST205's message names a table, so adding it widens
     * what gets echoed verbatim -- and doing that inside a commit whose whole
     * point is to stop echoing schema would be muddled. Moving that line is a
     * decision to take on its own terms, not a side effect of this one.
     */
    const e = new Error("Could not find the table 'public.users' in the schema cache");
    e.code = 'PGRST205';

    const res = await request(app(e)).get('/api/unwrapped');

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('public.users');
  });

  it('a client error keeps its status', async () => {
    const e = new Error('Nope');
    e.status = 400;

    const res = await request(app(e)).get('/api/unwrapped');
    expect(res.status).toBe(400);
  });
});
