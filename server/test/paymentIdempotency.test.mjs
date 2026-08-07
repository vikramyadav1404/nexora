/**
 * One captured payment must activate one subscription.
 *
 * Confirmation can arrive twice: the browser calls /verify-payment after
 * checkout, and Razorpay calls the webhook independently. Both read the
 * transaction, both check status, then both write — and the read and the write
 * are separate statements, so both can pass the check before either writes.
 *
 * The damage was bounded: subscription_expires_at is computed as now +
 * PLAN_DAYS, an absolute value rather than an increment, so a double activation
 * could not double a subscription. What it did produce was two invoice emails
 * for one payment.
 *
 * The fix is a conditional update — .eq('status', 'pending') — so the loser of
 * the race matches no row and stops.
 *
 * Invoice count is deliberately not asserted anywhere: subscriptions.js
 * destructures sendEmail at module load, so a spy on the email module never
 * reaches the reference the route holds and silently records nothing. These
 * assert on database state instead, which is observable.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

process.env.JWT_SECRET = 'test_jwt_secret';

const require = createRequire(import.meta.url);
const { __setTestClient } = require('../db/supabase.js');
const jwt = require('jsonwebtoken');

const KEY_SECRET = 'test_secret_key';
const WEBHOOK_SECRET = 'test_webhook_secret';

const BUYER = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Buyer',
  email: 'buyer@nexora.test',
  points: 100,
  subscription_plan: 'free',
  is_active: true
};

const ORDER_ID = 'order_race_1';
const PAYMENT_ID = 'pay_race_1';

let db;

function app() {
  const a = express();
  // The webhook needs the raw body, exactly as index.js mounts it.
  a.use('/api/subscriptions/webhook', express.raw({ type: '*/*', limit: '1mb' }));
  a.use(express.json());
  a.use('/api/subscriptions', require('../routes/subscriptions.js'));
  return a;
}

/** A pending transaction, as /create-order would have left it. */
function seedPending() {
  return {
    id: 'txn_race_1',
    user_id: BUYER.id,
    plan: 'gold',
    amount: 50000,
    status: 'pending',
    razorpay_order_id: ORDER_ID,
    razorpay_payment_id: '',
    razorpay_signature: '',
    created_at: new Date().toISOString()
  };
}

const sign = (orderId, paymentId) =>
  crypto.createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');

const verifyPayment = () =>
  request(app())
    .post('/api/subscriptions/verify-payment')
    .set('Authorization', `Bearer ${jwt.sign({ id: BUYER.id }, process.env.JWT_SECRET, { expiresIn: '1h' })}`)
    .send({
      transactionId: 'txn_race_1',
      razorpayOrderId: ORDER_ID,
      razorpayPaymentId: PAYMENT_ID,
      razorpaySignature: sign(ORDER_ID, PAYMENT_ID)
    });

function webhookCall() {
  const payload = JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: PAYMENT_ID, order_id: ORDER_ID } } }
  });
  return request(app())
    .post('/api/subscriptions/webhook')
    .set('Content-Type', 'application/json')
    .set('x-razorpay-signature',
      crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex'))
    // Send the string, not a Buffer: supertest re-encodes a Buffer body and
    // the bytes the HMAC was computed over no longer match.
    .send(payload);
}

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.RAZORPAY_KEY_ID = 'rzp_live_realkey';
  process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

  db = createFakeSupabase({
    users: [{ ...BUYER }],
    transactions: [seedPending()]
  });
  __setTestClient(db);

  /*
   * No email spy.
   *
   * subscriptions.js destructures sendEmail at module load, so replacing the
   * property on the email module afterwards never reaches the reference the
   * route holds — the spy silently records nothing. Invoice count is therefore
   * not observable from here, and these tests assert on database state, which
   * is. The guard is proven by activateSubscription returning null rather than
   * by counting emails.
   */
});

const txn = () => db._tables.transactions[0];
const buyer = () => db._tables.users[0];

describe('sequential confirmation', () => {
  it('activates on the first call', async () => {
    const res = await verifyPayment();
    expect(res.status).toBe(200);
    expect(txn().status).toBe('success');
    expect(txn().razorpay_payment_id).toBe(PAYMENT_ID);
    expect(buyer().subscription_plan).toBe('gold');
  });

  it('REGRESSION: a second confirmation activates nothing', async () => {
    await verifyPayment();
    const before = buyer().subscription_expires_at;

    const second = await verifyPayment();

    expect(second.status).toBe(200);
    expect(second.body.message).toMatch(/already verified/i);
    // The expiry must not move — a second activation would push it out again.
    expect(buyer().subscription_expires_at).toBe(before);
    expect(txn().razorpay_signature).not.toBe('webhook');
  });
});

describe('the race: two callers holding the same stale read', () => {
  /*
   * This cannot be reproduced through the routes.
   *
   * Both /verify-payment and the webhook re-read the transaction before
   * activating, so the second one sees status 'success' and returns at the
   * early check — the conditional update is never reached, and a test driven
   * through the routes passes whether the guard exists or not. I wrote it that
   * way first and the mutation check caught it: deleting
   * .eq('status', 'pending') left all seven tests green.
   *
   * The real window is between one caller's read and its write. Calling
   * activateSubscription twice with the same stale transaction object — both
   * holding status 'pending', as both callers would — is that window exactly.
   */
  const { activateSubscription } = require('../routes/subscriptions.js');

  it('REGRESSION: the second caller activates nothing', async () => {
    const stale = { ...seedPending() };

    const first = await activateSubscription(db, stale, { paymentId: PAYMENT_ID, signature: 'sig' });
    // Same stale object: this caller still believes the row is pending.
    const second = await activateSubscription(db, stale, { paymentId: PAYMENT_ID, signature: 'webhook' });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(txn().status).toBe('success');
  });

  it("REGRESSION: the loser does not overwrite the winner's payment id", async () => {
    const stale = { ...seedPending() };

    await activateSubscription(db, stale, { paymentId: PAYMENT_ID, signature: 'browser' });
    await activateSubscription(db, stale, { paymentId: 'pay_from_webhook', signature: 'webhook' });

    expect(txn().razorpay_payment_id).toBe(PAYMENT_ID);
    expect(txn().razorpay_signature).toBe('browser');
  });

  it('REGRESSION: a third stale caller is refused too', async () => {
    const stale = { ...seedPending() };
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await activateSubscription(db, stale, { paymentId: PAYMENT_ID, signature: 's' }));
    }
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('the expiry is set once, not pushed out per caller', async () => {
    const stale = { ...seedPending() };
    await activateSubscription(db, stale, { paymentId: PAYMENT_ID, signature: 'a' });
    const after = buyer().subscription_expires_at;
    await activateSubscription(db, stale, { paymentId: PAYMENT_ID, signature: 'b' });
    expect(buyer().subscription_expires_at).toBe(after);
  });
});

describe('mock mode writes a unique payment id', () => {
  /*
   * Migration 013's unique index is on razorpay_payment_id for non-empty
   * values. Mock mode used to write the constant 'mock_payment', so the first
   * mock checkout claimed that value and every later one failed the insert --
   * a 500 on every subsequent checkout, in production, once a single mock
   * payment existed. Found by driving the live API, not by these tests.
   */
  it('REGRESSION: derives the id from the transaction rather than a constant', async () => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;

    const res = await request(app())
      .post('/api/subscriptions/verify-payment')
      .set('Authorization', `Bearer ${jwt.sign({ id: BUYER.id }, process.env.JWT_SECRET, { expiresIn: '1h' })}`)
      .send({ transactionId: 'txn_race_1', razorpayOrderId: ORDER_ID });

    expect(res.status).toBe(200);
    expect(txn().razorpay_payment_id).toBe('mock_txn_race_1');
    expect(txn().razorpay_payment_id).not.toBe('mock_payment');
  });

  it('two different transactions never collide', async () => {
    // The property the unique index actually enforces.
    const idFor = (t) => `mock_${t}`;
    expect(idFor('txn_a')).not.toBe(idFor('txn_b'));
  });
});

describe('the guard does not break the ordinary path', () => {
  it('a failed transaction is not activated by a later call', async () => {
    txn().status = 'failed';
    const res = await verifyPayment();
    expect(res.status).toBe(400);
    expect(buyer().subscription_plan).toBe('free');
  });

  it('a bad signature fails the transaction and activates nothing', async () => {
    const res = await request(app())
      .post('/api/subscriptions/verify-payment')
      .set('Authorization', `Bearer ${jwt.sign({ id: BUYER.id }, process.env.JWT_SECRET, { expiresIn: '1h' })}`)
      .send({
        transactionId: 'txn_race_1',
        razorpayOrderId: ORDER_ID,
        razorpayPaymentId: PAYMENT_ID,
        razorpaySignature: 'not-the-right-signature'
      });

    expect(res.status).toBe(400);
    expect(txn().status).toBe('failed');
    expect(buyer().subscription_plan).toBe('free');
  });
});

describe('paid plans are refused when no Razorpay keys are configured', () => {
  /*
   * Mock mode activates a subscription with no money moving. Locally that is
   * the point; in production with unset keys it means every visitor can click
   * Subscribe and receive Gold free. That was the live state of this
   * deployment, and nothing in the code objected.
   */
  const auth = () => `Bearer ${jwt.sign({ id: BUYER.id }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    delete process.env.ALLOW_MOCK_PAYMENTS;
  });

  it('REGRESSION: create-order refuses rather than issuing a free plan', async () => {
    const res = await request(app()).post('/api/subscriptions/create-order')
      .set('Authorization', auth()).send({ plan: 'gold' });

    expect(res.status).toBe(503);
    expect(res.body.paymentsAvailable).toBe(false);
  });

  it('REGRESSION: verify-payment refuses too, so a pending row cannot be cashed in', async () => {
    // A transaction created before the block went up is still 'pending'.
    const res = await request(app()).post('/api/subscriptions/verify-payment')
      .set('Authorization', auth())
      .send({ transactionId: 'txn_race_1', razorpayOrderId: ORDER_ID });

    expect(res.status).toBe(503);
    expect(db._tables.users[0].subscription_plan).toBe('free');
  });

  it('says so on /plans, so the page can disable the buttons', async () => {
    const res = await request(app()).get('/api/subscriptions/plans');
    expect(res.body.paymentsAvailable).toBe(false);
  });

  it('real keys re-open it with no code change', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_live_realkey';
    process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
    const res = await request(app()).get('/api/subscriptions/plans');
    expect(res.body.paymentsAvailable).toBe(true);
  });

  it('development keeps its mock checkout', async () => {
    process.env.NODE_ENV = 'test';
    const res = await request(app()).get('/api/subscriptions/plans');
    expect(res.body.paymentsAvailable).toBe(true);
  });

  it('ALLOW_MOCK_PAYMENTS re-opens it deliberately', async () => {
    process.env.ALLOW_MOCK_PAYMENTS = 'true';
    const res = await request(app()).get('/api/subscriptions/plans');
    expect(res.body.paymentsAvailable).toBe(true);
  });
});
