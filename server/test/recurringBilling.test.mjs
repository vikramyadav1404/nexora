/**
 * Recurring billing on Razorpay Subscriptions (migration 024).
 *
 * Razorpay is a fake client injected through __setRazorpayForTests; webhooks
 * are signed exactly as Razorpay signs them. The SQL function's guarantees
 * (once per event, ordering, one extension per payment) are mirrored in the
 * fake and proven against Postgres in sqlFunctions.contract.test.mjs; these
 * tests are about the routes driving it correctly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

process.env.JWT_SECRET = 'test_jwt_secret';

const require = createRequire(import.meta.url);
const { __setTestClient } = require('../db/supabase.js');
const jwt = require('jsonwebtoken');
const subscriptions = require('../routes/subscriptions.js');

const KEY_SECRET = 'test_key_secret';
const WEBHOOK_SECRET = 'test_webhook_secret';
const USER = '00000000-0000-4000-8000-0000000000b1';
const SUB = 'sub_TEST123';
const DAY = 86400000;

let db;
let rzp;
const token = () => jwt.sign({ id: USER }, process.env.JWT_SECRET, { expiresIn: '1h' });
const user = () => db._tables.users.find(u => u.id === USER);
const unix = (ms) => Math.floor(ms / 1000);

function app() {
  const a = express();
  a.use('/api/subscriptions/webhook', express.raw({ type: '*/*', limit: '1mb' }));
  a.use(express.json());
  a.use('/api/subscriptions', subscriptions);
  return a;
}

const post = (path, body) =>
  request(app()).post(`/api/subscriptions${path}`).set('Authorization', `Bearer ${token()}`).send(body);

/** A webhook signed with the webhook secret, as Razorpay sends it. */
function webhook(event, { eventId = `evt_${Math.random().toString(36).slice(2)}` } = {}) {
  const raw = JSON.stringify(event);
  return request(app())
    .post('/api/subscriptions/webhook')
    .set('Content-Type', 'application/json')
    .set('x-razorpay-event-id', eventId)
    .set('x-razorpay-signature', crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'))
    .send(raw);
}

function subEvent(type, { status, currentEnd, createdAt = Date.now(), payment } = {}) {
  return {
    event: type,
    created_at: unix(createdAt),
    payload: {
      subscription: { entity: { id: SUB, plan_id: 'plan_GOLD', status, current_end: currentEnd ? unix(currentEnd) : null, notes: { plan: 'gold' } } },
      ...(payment ? { payment: { entity: { id: payment, amount: 100000 } } } : {})
    }
  };
}

const sign = (paymentId, subId) =>
  crypto.createHmac('sha256', KEY_SECRET).update(`${paymentId}|${subId}`).digest('hex');

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.RAZORPAY_KEY_ID = 'rzp_test_realkey';
  process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.RAZORPAY_PLAN_GOLD = 'plan_GOLD';
  delete process.env.RAZORPAY_PLAN_SILVER;
  delete process.env.RAZORPAY_PLAN_BRONZE;

  db = createFakeSupabase({
    users: [{
      id: USER, name: 'Payer', email: 'p@n.test', is_active: true, role: 'user',
      subscription_plan: 'free', subscription_expires_at: null,
      razorpay_subscription_id: '', subscription_status: 'none'
    }],
    transactions: [],
    billing_events: []
  });
  __setTestClient(db);

  rzp = {
    created: [], cancelled: [],
    period: Date.now() + 30 * DAY,
    subscriptions: {
      create: async (args) => { rzp.created.push(args); return { id: SUB, status: 'created' }; },
      fetch: async (id) => ({ id, plan_id: 'plan_GOLD', status: 'active', current_end: unix(rzp.period), notes: { plan: 'gold' } }),
      cancel: async (id, atCycleEnd) => {
        rzp.cancelled.push([id, atCycleEnd]);
        return { id, plan_id: 'plan_GOLD', status: 'active', current_end: unix(rzp.period) };
      }
    }
  };
  subscriptions.__setRazorpayForTests(rzp);
});

afterEach(() => {
  subscriptions.__setRazorpayForTests(null);
  for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_PLAN_GOLD']) delete process.env[k];
});

/** Create + verify, the path a real checkout takes. */
async function subscribeGold(paymentId = 'pay_first') {
  await post('/create-subscription', { plan: 'gold' });
  return post('/verify-subscription', {
    razorpayPaymentId: paymentId, razorpaySubscriptionId: SUB, razorpaySignature: sign(paymentId, SUB)
  });
}

describe('starting a recurring plan', () => {
  it('offers recurring only for plans with a Razorpay plan id', async () => {
    const res = await request(app()).get('/api/subscriptions/plans');
    expect(res.body.recurring).toEqual({ bronze: false, silver: false, gold: true });
  });

  it('creates the Razorpay subscription from the configured plan and remembers it', async () => {
    const res = await post('/create-subscription', { plan: 'gold' });
    expect(res.status).toBe(200);
    expect(rzp.created[0]).toMatchObject({ plan_id: 'plan_GOLD', notes: { user_id: USER, plan: 'gold' } });
    expect(user().razorpay_subscription_id).toBe(SUB);
  });

  it('refuses a plan with no recurring id, and a second live subscription', async () => {
    expect((await post('/create-subscription', { plan: 'silver' })).status).toBe(503);
    await subscribeGold();
    expect((await post('/create-subscription', { plan: 'gold' })).status).toBe(409);
  });

  it('verify grants the paid period plus grace, and records the payment once', async () => {
    const res = await subscribeGold();
    expect(res.status).toBe(200);
    expect(user().subscription_plan).toBe('gold');
    expect(user().subscription_status).toBe('active');
    const expires = new Date(user().subscription_expires_at).getTime();
    expect(Math.abs(expires - (rzp.period + 3 * DAY))).toBeLessThan(2000);
    expect(db._tables.transactions).toHaveLength(1);
  });

  it('REGRESSION: a forged or mismatched verify changes nothing', async () => {
    await post('/create-subscription', { plan: 'gold' });
    const forged = await post('/verify-subscription', {
      razorpayPaymentId: 'pay_x', razorpaySubscriptionId: SUB, razorpaySignature: 'f'.repeat(64)
    });
    const other = await post('/verify-subscription', {
      razorpayPaymentId: 'pay_x', razorpaySubscriptionId: 'sub_SOMEONE_ELSE', razorpaySignature: sign('pay_x', 'sub_SOMEONE_ELSE')
    });
    expect(forged.status).toBe(400);
    expect(other.status).toBe(400);
    expect(user().subscription_plan).toBe('free');
    expect(db._tables.transactions).toHaveLength(0);
  });
});

describe('renewals and failures arrive by webhook', () => {
  it('REGRESSION: the first charge reported by verify AND by webhook extends once', async () => {
    await subscribeGold('pay_first');
    const afterVerify = user().subscription_expires_at;

    const res = await webhook(subEvent('subscription.charged', { status: 'active', currentEnd: rzp.period, payment: 'pay_first' }));

    expect(res.status).toBe(200);
    expect(user().subscription_expires_at).toBe(afterVerify);
    expect(db._tables.transactions).toHaveLength(1);
  });

  it('a renewal charge moves access to the new period', async () => {
    await subscribeGold();
    const next = rzp.period + 30 * DAY;
    await webhook(subEvent('subscription.charged', { status: 'active', currentEnd: next, payment: 'pay_month2' }));
    expect(new Date(user().subscription_expires_at).getTime()).toBe(next + 3 * DAY - (next + 3 * DAY) % 1000);
    expect(db._tables.transactions).toHaveLength(2);
  });

  it('REGRESSION: a redelivered webhook (same event id) applies once', async () => {
    await subscribeGold();
    const next = rzp.period + 30 * DAY;
    const ev = subEvent('subscription.charged', { status: 'active', currentEnd: next, payment: 'pay_month2' });
    await webhook(ev, { eventId: 'evt_same' });
    const once = user().subscription_expires_at;
    const again = await webhook(ev, { eventId: 'evt_same' });
    expect(again.body.outcome).toBe('duplicate');
    expect(user().subscription_expires_at).toBe(once);
  });

  it('a failed renewal (pending) keeps access through grace; halted ends it now', async () => {
    await subscribeGold();
    await webhook(subEvent('subscription.pending', { status: 'pending', currentEnd: rzp.period }));
    expect(user().subscription_status).toBe('pending');
    expect(new Date(user().subscription_expires_at).getTime()).toBeGreaterThan(rzp.period);

    await webhook(subEvent('subscription.halted', { status: 'halted', currentEnd: rzp.period }));
    expect(user().subscription_status).toBe('halted');
    expect(new Date(user().subscription_expires_at).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('REGRESSION: an older event arriving late cannot undo a halt', async () => {
    await subscribeGold();
    const now = Date.now();
    await webhook(subEvent('subscription.halted', { status: 'halted', currentEnd: rzp.period, createdAt: now }));
    await webhook(subEvent('subscription.activated', { status: 'active', currentEnd: rzp.period, createdAt: now - 60_000 }));
    expect(user().subscription_status).toBe('halted');
  });

  it('a subscription nobody owns is acknowledged, not retried forever', async () => {
    const res = await webhook({ ...subEvent('subscription.charged', { status: 'active', currentEnd: rzp.period, payment: 'pay_z' }), payload: { subscription: { entity: { id: 'sub_UNKNOWN', plan_id: 'plan_GOLD', status: 'active' } } } });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('unknown_subscription');
  });

  it('an unsigned subscription webhook is rejected', async () => {
    const res = await request(app()).post('/api/subscriptions/webhook')
      .set('Content-Type', 'application/json').set('x-razorpay-signature', 'nope')
      .send(JSON.stringify(subEvent('subscription.charged', { status: 'active', payment: 'pay_evil' })));
    expect(res.status).toBe(400);
    expect(db._tables.transactions).toHaveLength(0);
  });
});

describe('cancelling a recurring plan', () => {
  it('turns auto-renew off at Razorpay and keeps access to the period end, without grace', async () => {
    await subscribeGold();
    const res = await post('/cancel', {});
    expect(res.status).toBe(200);
    expect(res.body.autoRenew).toBe(false);
    expect(res.body.daysForfeited).toBe(0);
    expect(rzp.cancelled).toEqual([[SUB, true]]);
    expect(user().subscription_status).toBe('cancelled');
    expect(Math.abs(new Date(user().subscription_expires_at).getTime() - rzp.period)).toBeLessThan(2000);
    expect(user().subscription_plan).toBe('gold');
  });

  it('a one-time plan still cancels the old way', async () => {
    user().subscription_plan = 'gold';
    user().subscription_expires_at = new Date(Date.now() + 10 * DAY).toISOString();
    const res = await post('/cancel', {});
    expect(res.body.cancelledPlan).toBe('gold');
    expect(rzp.cancelled).toHaveLength(0);
    expect(user().subscription_plan).toBe('free');
  });
});

describe('before migration 024', () => {
  it('verify answers 503 naming it, and grants nothing', async () => {
    await post('/create-subscription', { plan: 'gold' });
    delete db._rpc.apply_subscription_event;
    const res = await post('/verify-subscription', {
      razorpayPaymentId: 'pay_first', razorpaySubscriptionId: SUB, razorpaySignature: sign('pay_first', SUB)
    });
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/024_recurring_billing\.sql/);
    expect(user().subscription_plan).toBe('free');
  });
});
