/**
 * Payment verification.
 *
 * The headline case is `grants itself Gold` below: before this change, any
 * authenticated user could POST {isMock: true, plan: 'gold'} and the server
 * would skip signature verification and activate whatever plan the request
 * body asked for. These tests fail against the old implementation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

const KEY_SECRET = 'test_secret_key';

const BUYER = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Buyer',
  email: 'buyer@nexora.test',
  points: 100,
  subscription_plan: 'free',
  is_active: true
};
const OTHER = {
  id: '00000000-0000-4000-8000-000000000002',
  name: 'Other',
  email: 'other@nexora.test',
  points: 100,
  subscription_plan: 'free',
  is_active: true
};

let db;
/** Whose bearer token the next request carries. */
let currentUser = BUYER;

/*
 * Load the server through createRequire, not `import`.
 *
 * The server is CommonJS. An `await import()` of a CJS file goes through
 * Vite's registry, while the routers reach their own dependencies via plain
 * `require()` in Node's registry — two separate copies of every module. The
 * test would then inject a fake client into a `db/supabase` instance that the
 * router never sees, and `protect` would 401 against the real one.
 *
 * createRequire puts the test in the same registry as the code under test, so
 * the injection seam actually takes effect. It also means the genuine `protect`
 * middleware runs, which is better coverage than stubbing it out.
 */
import { createRequire } from 'node:module';

process.env.JWT_SECRET = 'test_jwt_secret';

const require = createRequire(import.meta.url);
const { __setTestClient } = require('../db/supabase.js');
const jwt = require('jsonwebtoken');
const subscriptionsRouter = require('../routes/subscriptions.js');

const tokenFor = (user) => jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });

function buildApp() {
  const app = express();
  // Mirrors index.js: raw body on the webhook path, JSON everywhere else.
  app.use('/api/subscriptions/webhook', express.raw({ type: '*/*' }));
  app.use(express.json());
  app.use('/api/subscriptions', subscriptionsRouter);
  return app;
}

async function seedPendingTransaction(plan = 'bronze', userId = BUYER.id) {
  const tx = {
    id: `tx_${plan}_${userId.slice(-4)}`,
    user_id: userId,
    plan,
    amount: 100,
    razorpay_order_id: `order_${plan}`,
    invoice_number: 'INV-1',
    status: 'pending'
  };
  db._tables.transactions.push(tx);
  return tx;
}

beforeEach(() => {
  db = createFakeSupabase({ users: [{ ...BUYER }, { ...OTHER }] });
  __setTestClient(db);
  currentUser = db._tables.users[0];
  process.env.RAZORPAY_KEY_ID = 'rzp_live_realkey';
  process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  process.env.NODE_ENV = 'test';
});

describe('POST /api/subscriptions/verify-payment', () => {
  it('REGRESSION: a client cannot skip signature verification with isMock, or pick its own plan', async () => {
    const tx = await seedPendingTransaction('bronze');

    const res = await request(buildApp())
      .post('/api/subscriptions/verify-payment')
      .set('Authorization', `Bearer ${tokenFor(currentUser)}`)
      .send({
        transactionId: tx.id,
        razorpayOrderId: tx.razorpay_order_id,
        razorpayPaymentId: 'pay_fake',
        razorpaySignature: 'not_a_real_signature',
        // The old code trusted both of these from the request body.
        isMock: true,
        plan: 'gold'
      });

    expect(res.status).toBe(400);
    expect(db._tables.users.find(u => u.id === BUYER.id).subscription_plan).toBe('free');
    expect(db._tables.transactions.find(t => t.id === tx.id).status).toBe('failed');
  });

  it('activates the plan recorded on the transaction, not the one in the body', async () => {
    const tx = await seedPendingTransaction('bronze');
    const paymentId = 'pay_real';
    const signature = crypto
      .createHmac('sha256', KEY_SECRET)
      .update(`${tx.razorpay_order_id}|${paymentId}`)
      .digest('hex');

    const res = await request(buildApp())
      .post('/api/subscriptions/verify-payment')
      .set('Authorization', `Bearer ${tokenFor(currentUser)}`)
      .send({
        transactionId: tx.id,
        razorpayOrderId: tx.razorpay_order_id,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature,
        plan: 'gold' // ignored
      });

    expect(res.status).toBe(200);
    expect(db._tables.users.find(u => u.id === BUYER.id).subscription_plan).toBe('bronze');
  });

  it('rejects a valid signature for a different order', async () => {
    const tx = await seedPendingTransaction('bronze');
    const signature = crypto
      .createHmac('sha256', KEY_SECRET)
      .update('order_somethingelse|pay_1')
      .digest('hex');

    const res = await request(buildApp())
      .post('/api/subscriptions/verify-payment')
      .set('Authorization', `Bearer ${tokenFor(currentUser)}`)
      .send({
        transactionId: tx.id,
        razorpayOrderId: 'order_somethingelse',
        razorpayPaymentId: 'pay_1',
        razorpaySignature: signature
      });

    expect(res.status).toBe(400);
    expect(db._tables.users.find(u => u.id === BUYER.id).subscription_plan).toBe('free');
  });

  it("cannot verify another user's transaction", async () => {
    const victimTx = await seedPendingTransaction('gold', OTHER.id);

    const res = await request(buildApp())
      .post('/api/subscriptions/verify-payment')
      .set('Authorization', `Bearer ${tokenFor(currentUser)}`)
      .send({ transactionId: victimTx.id, razorpayOrderId: victimTx.razorpay_order_id });

    expect(res.status).toBe(404);
    expect(db._tables.users.find(u => u.id === OTHER.id).subscription_plan).toBe('free');
    expect(db._tables.users.find(u => u.id === BUYER.id).subscription_plan).toBe('free');
  });

  it('is idempotent — a replayed callback does not re-activate', async () => {
    const tx = await seedPendingTransaction('silver');
    tx.status = 'success';

    const res = await request(buildApp())
      .post('/api/subscriptions/verify-payment')
      .set('Authorization', `Bearer ${tokenFor(currentUser)}`)
      .send({ transactionId: tx.id, razorpayOrderId: tx.razorpay_order_id });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/already verified/i);
  });

  it('auto-verifies only when the server itself has no real Razorpay keys', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_YOUR_KEY_ID';
    process.env.RAZORPAY_KEY_SECRET = 'YOUR_KEY_SECRET';
    const tx = await seedPendingTransaction('bronze');

    const res = await request(buildApp())
      .post('/api/subscriptions/verify-payment')
      .set('Authorization', `Bearer ${tokenFor(currentUser)}`)
      .send({ transactionId: tx.id, razorpayOrderId: tx.razorpay_order_id });

    expect(res.status).toBe(200);
    expect(db._tables.users.find(u => u.id === BUYER.id).subscription_plan).toBe('bronze');
  });
});

describe('POST /api/subscriptions/webhook', () => {
  beforeEach(() => {
    process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
  });

  it('rejects an unsigned payload', async () => {
    const res = await request(buildApp())
      .post('/api/subscriptions/webhook')
      .set('Content-Type', 'application/json')
      .send(Buffer.from(JSON.stringify({ event: 'payment.captured' })));

    expect(res.status).toBe(400);
  });

  it('activates the subscription when the signature is valid', async () => {
    const tx = await seedPendingTransaction('gold');
    const payload = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_hook', order_id: tx.razorpay_order_id } } }
    });
    const signature = crypto.createHmac('sha256', 'whsec_test').update(payload).digest('hex');

    const res = await request(buildApp())
      .post('/api/subscriptions/webhook')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', signature)
      // Send the string, not a Buffer: superagent JSON-stringifies a Buffer
      // into {"type":"Buffer","data":[…]}, which changes the signed bytes.
      .send(payload);

    expect(res.status).toBe(200);
    // Activation runs after the ack, so let the microtask queue drain.
    await new Promise(r => setTimeout(r, 30));
    expect(db._tables.users.find(u => u.id === BUYER.id).subscription_plan).toBe('gold');
  });
});
