/**
 * Cancelling a subscription.
 *
 * Worth stating plainly, because it drives every assertion here: nothing in
 * this product recurs. A payment buys PLAN_DAYS of access, no card is stored,
 * and getActivePlan() returns 'free' by itself once subscription_expires_at
 * passes. So cancel is not "stop charging me" — there is no future charge to
 * stop. It is "end it now, and give up the days I already paid for".
 *
 * That makes daysForfeited the important part of the response rather than a
 * nicety: it is the only thing telling the user what the button actually costs
 * them. It is asserted here as behaviour, not decoration.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

process.env.JWT_SECRET = 'test_jwt_secret';

const require = createRequire(import.meta.url);
const { __setTestClient } = require('../db/supabase.js');
const jwt = require('jsonwebtoken');

const USER_ID = '00000000-0000-4000-8000-000000000001';

/** `days` from now, as the column stores it. */
const inDays = (days) => new Date(Date.now() + days * 86400000).toISOString();

function subscriber(overrides = {}) {
  return {
    id: USER_ID,
    name: 'Subscriber',
    email: 'sub@nexora.test',
    points: 100,
    is_active: true,
    subscription_plan: 'gold',
    subscription_expires_at: inDays(20),
    ...overrides
  };
}

let db;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/subscriptions', require('../routes/subscriptions.js'));
  return a;
}

const token = () => jwt.sign({ id: USER_ID }, process.env.JWT_SECRET, { expiresIn: '1h' });

const cancel = () =>
  request(app()).post('/api/subscriptions/cancel').set('Authorization', `Bearer ${token()}`);

const me = () => db._tables.users[0];

function seed(user = subscriber()) {
  db = createFakeSupabase({ users: [user], transactions: [] });
  __setTestClient(db);
}

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  seed();
});

describe('cancelling a paid plan', () => {
  it('drops the user to free immediately', async () => {
    const res = await cancel();

    expect(res.status).toBe(200);
    expect(res.body.subscription.plan).toBe('free');
    expect(res.body.subscription.expiresAt).toBeNull();
    expect(me().subscription_plan).toBe('free');
    expect(me().subscription_expires_at).toBeNull();
  });

  it('reports which plan was cancelled', async () => {
    const res = await cancel();
    expect(res.body.cancelledPlan).toBe('gold');
  });

  it('clears the expiry rather than leaving a stale date behind', async () => {
    // A leftover future expiry with plan 'free' is harmless to getActivePlan
    // but is a trap for anything reading the column directly.
    await cancel();
    expect(me().subscription_expires_at).toBeNull();
  });
});

describe('daysForfeited — what the button actually costs', () => {
  it('REGRESSION: reports the days being given up', async () => {
    seed(subscriber({ subscription_expires_at: inDays(20) }));
    const res = await cancel();
    expect(res.body.daysForfeited).toBe(20);
  });

  it('rounds a part-day up, so a user is never told they lose less than they do', async () => {
    seed(subscriber({ subscription_expires_at: inDays(0.4) }));
    const res = await cancel();
    expect(res.body.daysForfeited).toBe(1);
  });

  it('never reports a negative count', async () => {
    // Defensive: an expiry in the past should not produce "-3 days".
    // Such a user is already free, so this asserts the free-plan path instead.
    seed(subscriber({ subscription_expires_at: inDays(-3) }));
    const res = await cancel();
    expect(res.status).toBe(400);
  });

  it('handles a paid plan with no expiry set at all', async () => {
    seed(subscriber({ subscription_expires_at: null }));
    const res = await cancel();
    expect(res.status).toBe(200);
    expect(res.body.daysForfeited).toBe(0);
    expect(me().subscription_plan).toBe('free');
  });
});

describe('who may cancel', () => {
  it('REGRESSION: a free user is refused', async () => {
    seed(subscriber({ subscription_plan: 'free', subscription_expires_at: null }));
    const res = await cancel();
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not on a paid plan/i);
  });

  it('REGRESSION: an already-expired plan is refused, not "cancelled" again', async () => {
    // The column still says 'gold' but the date has passed. getActivePlan calls
    // this free, and so must the route — checking the raw column would let this
    // through and report a cancellation that changes nothing.
    seed(subscriber({ subscription_plan: 'gold', subscription_expires_at: inDays(-1) }));

    const res = await cancel();

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not on a paid plan/i);
  });

  it('REGRESSION: rejects an unauthenticated caller', async () => {
    const res = await request(app()).post('/api/subscriptions/cancel');
    expect(res.status).toBe(401);
    expect(me().subscription_plan).toBe('gold');
  });

  it('cancels only the caller, not another subscriber', async () => {
    const other = { ...subscriber(), id: '00000000-0000-4000-8000-000000000002', email: 'other@nexora.test' };
    db = createFakeSupabase({ users: [subscriber(), other], transactions: [] });
    __setTestClient(db);

    await cancel();

    expect(db._tables.users[0].subscription_plan).toBe('free');
    expect(db._tables.users[1].subscription_plan).toBe('gold');
  });
});

describe('cancelling twice', () => {
  it('REGRESSION: the second call is refused rather than reporting a fresh cancellation', async () => {
    const first = await cancel();
    expect(first.body.daysForfeited).toBe(20);

    // By now the user is free, so this takes the free-plan path.
    const second = await cancel();
    expect(second.status).toBe(400);
    expect(me().subscription_plan).toBe('free');
  });

  it('REGRESSION: two callers racing on the same read — only one reports a cancellation', async () => {
    /*
     * The route reads the user (via protect), decides, then writes. Two tabs
     * both clicking Cancel can both pass the getActivePlan check before either
     * writes. The conditional .eq('subscription_plan', active) settles it.
     *
     * Driven through the route this is unreproducible for the same reason the
     * payment race was: protect re-reads the user, so the second request sees
     * 'free' and stops at the early check — that version passed with the guard
     * deleted, which the mutation run caught. Calling cancelSubscription twice
     * with the same stale row is the actual window: both callers still believe
     * the plan is 'gold'.
     */
    const { cancelSubscription } = require('../routes/subscriptions.js');
    const stale = subscriber();

    const first = await cancelSubscription(db, stale);
    const second = await cancelSubscription(db, stale);

    expect(first.cancelledPlan).toBe('gold');
    expect(second).toBeNull();
    expect(me().subscription_plan).toBe('free');
  });

  it('REGRESSION: a third stale caller is refused too', async () => {
    const { cancelSubscription } = require('../routes/subscriptions.js');
    const stale = subscriber();

    const results = [];
    for (let i = 0; i < 3; i++) results.push(await cancelSubscription(db, stale));

    expect(results.filter((r) => r && r.cancelledPlan)).toHaveLength(1);
  });
});
