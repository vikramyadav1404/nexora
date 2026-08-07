/**
 * The two-day trial, and renewal stacking.
 *
 * These two live together because they share one risk: both hand out time
 * without a payment landing, so both are only correct if they cannot run twice.
 *
 * The trial's whole value proposition rests on "once per account, ever". If a
 * second trial can be started the plan is free forever, so the guard is not a
 * hardening detail -- it is the feature.
 *
 * Renewal stacking is the riskier of the two. Expiry used to be computed flat
 * as `now + PLAN_DAYS`, which meant a double activation could not extend
 * anything: writing the same date twice lands on the same date. Adding to the
 * existing expiry removes that property, so the payment idempotency guard now
 * carries weight it did not carry before. The stacking tests and the
 * paymentIdempotency suite have to stay green together.
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
const DAY = 86400000;

const inDays = (d) => new Date(Date.now() + d * DAY).toISOString();
const daysBetween = (iso) => Math.round((new Date(iso) - Date.now()) / DAY);

function user(overrides = {}) {
  return {
    id: USER_ID,
    name: 'Trialist',
    email: 'trial@nexora.test',
    points: 0,
    is_active: true,
    subscription_plan: 'free',
    subscription_expires_at: null,
    trial_used_at: null,
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

const startTrial = (plan = 'gold') =>
  request(app()).post('/api/subscriptions/trial')
    .set('Authorization', `Bearer ${token()}`)
    .send({ plan });

const me = () => db._tables.users[0];

function seed(u = user()) {
  db = createFakeSupabase({ users: [u], transactions: [] });
  __setTestClient(db);
}

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  seed();
});

describe('starting a trial', () => {
  it('grants two days of the chosen plan', async () => {
    const res = await startTrial('gold');

    expect(res.status).toBe(200);
    expect(res.body.isTrial).toBe(true);
    expect(res.body.trialDays).toBe(2);
    expect(me().subscription_plan).toBe('gold');
    expect(daysBetween(me().subscription_expires_at)).toBe(2);
  });

  it('stamps trial_used_at', async () => {
    await startTrial();
    expect(me().trial_used_at).toBeTruthy();
  });

  it('rejects an unknown plan', async () => {
    const res = await startTrial('platinum');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/unknown plan/i);
    expect(me().trial_used_at).toBeNull();
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await request(app()).post('/api/subscriptions/trial').send({ plan: 'gold' });
    expect(res.status).toBe(401);
    expect(me().trial_used_at).toBeNull();
  });
});

describe('once per account, ever', () => {
  it('REGRESSION: a second trial is refused', async () => {
    await startTrial();
    // The first trial is still running, so this also has an active plan --
    // seed a lapsed state to isolate the trial_used_at check specifically.
    seed(user({ trial_used_at: inDays(-10), subscription_plan: 'free', subscription_expires_at: null }));

    const res = await startTrial();

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already used/i);
    expect(me().subscription_plan).toBe('free');
  });

  it('REGRESSION: cancelling mid-trial does not restore eligibility', async () => {
    await startTrial();
    expect(me().trial_used_at).toBeTruthy();

    await request(app()).post('/api/subscriptions/cancel').set('Authorization', `Bearer ${token()}`);

    // Cancel must clear the plan but never the trial stamp.
    expect(me().subscription_plan).toBe('free');
    expect(me().trial_used_at).toBeTruthy();

    const again = await startTrial();
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/already used/i);
  });

  it('REGRESSION: two simultaneous requests grant only one trial', async () => {
    /*
     * Both callers read trial_used_at as null and both decide the account is
     * eligible. The .is('trial_used_at', null) condition on the write is what
     * stops the second landing.
     *
     * Driven through the route this is invisible: protect re-reads the user, so
     * the second request sees the stamp and stops at the early check. The first
     * version of this test drove the fake client directly, which meant it was
     * testing the test helper -- deleting the condition from the route left it
     * green. Calling startTrialFor twice with one stale row is the real window.
     */
    const { startTrialFor } = require('../routes/subscriptions.js');
    const stale = user();

    const first = await startTrialFor(db, stale, 'gold');
    const second = await startTrialFor(db, stale, 'gold');

    expect(first.expiresAt).toBeTruthy();
    expect(second).toBeNull();
    expect(daysBetween(me().subscription_expires_at)).toBe(2);
  });

  it('REGRESSION: a third stale caller is refused too', async () => {
    const { startTrialFor } = require('../routes/subscriptions.js');
    const stale = user();

    const results = [];
    for (let i = 0; i < 3; i++) results.push(await startTrialFor(db, stale, 'gold'));

    expect(results.filter((r) => r && r.expiresAt)).toHaveLength(1);
  });

  it('refuses a trial while a paid plan is running', async () => {
    seed(user({ subscription_plan: 'gold', subscription_expires_at: inDays(20) }));

    const res = await startTrial();

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already have an active plan/i);
    // The paid expiry must be untouched -- replacing 20 paid days with 2 free
    // ones would be strictly worse for the user.
    expect(daysBetween(me().subscription_expires_at)).toBe(20);
  });

  it('allows a trial once a previous plan has lapsed', async () => {
    seed(user({ subscription_plan: 'gold', subscription_expires_at: inDays(-1) }));
    const res = await startTrial('bronze');
    expect(res.status).toBe(200);
    expect(me().subscription_plan).toBe('bronze');
  });
});

describe('extendFrom, directly', () => {
  /*
   * Unit-tested rather than driven through activateSubscription because one of
   * its branches cannot be reached from there: a past expiry makes getActivePlan
   * return 'free', so the caller passes null instead of the stale date. Deleting
   * Math.max broke nothing in the route-level tests, which means that branch was
   * being claimed but never checked.
   */
  const { extendFrom } = require('../routes/subscriptions.js');

  it('adds days to a future expiry', () => {
    expect(daysBetween(extendFrom(inDays(10), 30).toISOString())).toBe(40);
  });

  it('REGRESSION: starts from today when the expiry is already past', () => {
    // Without Math.max this returns 15 days in the past, silently granting a
    // subscription that is already expired.
    expect(daysBetween(extendFrom(inDays(-15), 30).toISOString())).toBe(30);
  });

  it('starts from today when there is no expiry at all', () => {
    expect(daysBetween(extendFrom(null, 30).toISOString())).toBe(30);
  });

  it('handles the trial length too', () => {
    expect(daysBetween(extendFrom(null, 2).toISOString())).toBe(2);
  });
});

describe('renewal stacks instead of resetting', () => {
  const { activateSubscription } = require('../routes/subscriptions.js');

  const txn = (plan, id = 'txn_1') => ({
    id, user_id: USER_ID, plan, amount: 50000, status: 'pending',
    razorpay_order_id: 'order_1', razorpay_payment_id: '', razorpay_signature: ''
  });

  function seedWithTxn(u, t) {
    db = createFakeSupabase({ users: [u], transactions: [t] });
    __setTestClient(db);
  }

  it('REGRESSION: renewing with time left adds to it rather than discarding it', async () => {
    seedWithTxn(user({ subscription_plan: 'gold', subscription_expires_at: inDays(10) }), txn('gold'));

    await activateSubscription(db, txn('gold'), { paymentId: 'pay_1', signature: 's' });

    // 10 remaining + 30 bought. The old flat `now + 30` gave 30 and ate the 10.
    expect(daysBetween(me().subscription_expires_at)).toBe(40);
  });

  it('a lapsed plan renews from today, not from when it ran out', async () => {
    seedWithTxn(user({ subscription_plan: 'gold', subscription_expires_at: inDays(-15) }), txn('gold'));

    await activateSubscription(db, txn('gold'), { paymentId: 'pay_1', signature: 's' });

    expect(daysBetween(me().subscription_expires_at)).toBe(30);
  });

  it('REGRESSION: switching plans starts fresh rather than carrying time across tiers', async () => {
    // 10 days of Gold must not become 10 extra days of Bronze.
    seedWithTxn(user({ subscription_plan: 'gold', subscription_expires_at: inDays(10) }), txn('bronze'));

    await activateSubscription(db, txn('bronze'), { paymentId: 'pay_1', signature: 's' });

    expect(me().subscription_plan).toBe('bronze');
    expect(daysBetween(me().subscription_expires_at)).toBe(30);
  });

  it('a first purchase from free gets exactly PLAN_DAYS', async () => {
    seedWithTxn(user(), txn('silver'));
    await activateSubscription(db, txn('silver'), { paymentId: 'pay_1', signature: 's' });
    expect(daysBetween(me().subscription_expires_at)).toBe(30);
  });

  it('paying during a trial stacks onto the trial days', async () => {
    seedWithTxn(user({ subscription_plan: 'gold', subscription_expires_at: inDays(2), trial_used_at: inDays(0) }), txn('gold'));

    await activateSubscription(db, txn('gold'), { paymentId: 'pay_1', signature: 's' });

    expect(daysBetween(me().subscription_expires_at)).toBe(32);
  });

  it('REGRESSION: stacking does not let one payment be counted twice', async () => {
    /*
     * The important one. Stacking removed the property that made double
     * activation harmless, so the idempotency guard is now the only thing
     * standing between a single payment and 60 days.
     */
    seedWithTxn(user({ subscription_plan: 'gold', subscription_expires_at: inDays(10) }), txn('gold'));
    const stale = txn('gold');

    const first = await activateSubscription(db, stale, { paymentId: 'pay_1', signature: 'browser' });
    const second = await activateSubscription(db, stale, { paymentId: 'pay_1', signature: 'webhook' });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(daysBetween(me().subscription_expires_at)).toBe(40); // not 70
  });
});
