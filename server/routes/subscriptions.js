const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { getSupabase } = require('../db/supabase');
const { shapeTransaction } = require('../db/helpers');
const { protect } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');
const { sendError, asyncHandler } = require('../utils/respond');

const PLANS = {
  bronze: { price: 10000, name: 'Bronze', description: '5 questions/day' },
  silver: { price: 30000, name: 'Silver', description: '10 questions/day' },
  gold: { price: 100000, name: 'Gold', description: 'Unlimited questions/day' }
};

const PLAN_DAYS = 30;

/**
 * Whether real Razorpay credentials are configured.
 *
 * This is the ONLY source of truth for mock mode. It used to be possible for a
 * client to declare `isMock: true` in the request body and skip signature
 * verification entirely — i.e. any logged-in user could grant themselves Gold.
 * Nothing the client sends is trusted here any more.
 */
function isMockMode() {
  const id = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!id || !secret) return true;
  if (id === 'rzp_test_YOUR_KEY_ID' || String(id).includes('YOUR_KEY')) return true;
  if (secret === 'YOUR_KEY_SECRET' || String(secret).includes('YOUR_KEY')) return true;
  return false;
}

const getRazorpay = () => {
  if (isMockMode()) return null;
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
};

// Payment window is open unless explicitly enforced (10:00–11:00 AM IST).
const isPaymentWindowOpen = () => {
  if (process.env.PAYMENT_WINDOW_ENFORCED === 'true') {
    const now = new Date();
    const istDate = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    return istDate.getUTCHours() === 10;
  }
  return true;
};

function verifySignature(orderId, paymentId, signature) {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret || !orderId || !paymentId || !signature) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  // Constant-time compare — a plain === leaks timing information
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Marks a transaction paid and activates the plan recorded ON THAT ROW. */
/**
 * Flip a pending transaction to success and extend the subscription.
 *
 * Returns null when the transaction was already claimed by someone else.
 *
 * Both callers -- the browser hitting /verify-payment and Razorpay hitting the
 * webhook -- read the transaction, check its status, and then write. Those are
 * separate statements, so both can pass the check before either writes. The
 * update below is what closes that: `.eq('status', 'pending')` means only one
 * of them matches a row, and the loser is told so by getting none back.
 *
 * Without it the second caller would activate again and send a second invoice.
 * It could not double the subscription -- expiresAt is computed as now +
 * PLAN_DAYS, an absolute value rather than an increment -- but two invoices for
 * one payment is its own problem.
 */
async function activateSubscription(db, transaction, { paymentId, signature }) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + PLAN_DAYS);

  const { data: claimed, error: claimErr } = await db.from('transactions').update({
    status: 'success',
    razorpay_payment_id: paymentId || '',
    razorpay_signature: signature || ''
  })
    .eq('id', transaction.id)
    // The guard. Matches nothing if another caller already flipped it.
    .eq('status', 'pending')
    .select('id');

  if (claimErr) throw claimErr;

  // Lost the race. The winner has already activated and emailed; doing either
  // again is exactly what this exists to prevent.
  if (!claimed || claimed.length === 0) return null;

  const { data: user, error } = await db.from('users').update({
    // plan comes from the stored transaction, never from the request body
    subscription_plan: transaction.plan,
    subscription_expires_at: expiresAt.toISOString()
  }).eq('id', transaction.user_id).select().single();

  if (error) throw error;
  return { user, expiresAt };
}

async function emailInvoice(user, transaction, expiresAt) {
  const planInfo = PLANS[transaction.plan];
  if (!planInfo || !user?.email) return;
  await sendEmail(
    user.email,
    `Nexora Invoice - ${planInfo.name} Plan`,
    `
    <div style="font-family: Arial; max-width: 600px; margin: auto; padding: 30px;">
      <h2>Nexora payment invoice</h2>
      <p>Invoice #${transaction.invoice_number}</p>
      <p>Plan: ${planInfo.name}</p>
      <p>Amount: ₹${Number(transaction.amount)}</p>
      <p>Valid until: ${expiresAt.toLocaleDateString('en-IN')}</p>
    </div>
    `
  ).catch(() => { /* a failed invoice email must not fail the payment */ });
}

// GET /api/subscriptions/plans
router.get('/plans', (req, res) => {
  // Static payload — safe to cache at the edge
  res.set('Cache-Control', 'public, max-age=300, s-maxage=3600');
  res.json({ plans: PLANS, windowOpen: isPaymentWindowOpen(), isMock: isMockMode() });
});

// POST /api/subscriptions/create-order
router.post('/create-order', protect, asyncHandler(async (req, res) => {
  if (!isPaymentWindowOpen()) {
    const istDate = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
    return res.status(403).json({
      message: `Payments are only accepted between 10:00 AM - 11:00 AM IST. Current IST time: ${istDate.getUTCHours()}:${String(istDate.getUTCMinutes()).padStart(2, '0')}`,
      windowOpen: false
    });
  }

  const { plan } = req.body;
  if (!PLANS[plan]) return res.status(400).json({ message: 'Invalid plan' });

  const razorpay = getRazorpay();
  let orderId;

  if (razorpay) {
    const order = await razorpay.orders.create({
      amount: PLANS[plan].price,
      currency: 'INR',
      receipt: `nexora_${req.user.id}_${Date.now()}`
    });
    orderId = order.id;
  } else {
    orderId = `order_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  const { data: transaction, error } = await getSupabase().from('transactions').insert({
    user_id: req.user.id,
    plan,
    amount: PLANS[plan].price / 100,
    razorpay_order_id: orderId,
    invoice_number: `INV-${Date.now()}`,
    status: 'pending'
  }).select().single();

  if (error) throw error;

  res.json({
    orderId,
    amount: PLANS[plan].price,
    currency: 'INR',
    plan,
    transactionId: transaction.id,
    keyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_mock',
    // Informational only — the server decides this, and re-derives it on verify
    isMock: !razorpay
  });
}, 'Could not start checkout'));

// POST /api/subscriptions/verify-payment
router.post('/verify-payment', protect, asyncHandler(async (req, res) => {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature, transactionId } = req.body;
  const db = getSupabase();

  if (!transactionId) {
    return res.status(400).json({ message: 'transactionId is required' });
  }

  // Scoped to the caller — previously any user could verify anyone's transaction
  const { data: transaction } = await db
    .from('transactions')
    .select('*')
    .eq('id', transactionId)
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (!transaction) return res.status(404).json({ message: 'Transaction not found' });

  // Idempotent: a double-submitted callback must not extend the plan twice
  if (transaction.status === 'success') {
    return res.json({
      message: 'Payment already verified',
      subscription: { plan: transaction.plan }
    });
  }
  if (transaction.status === 'failed') {
    return res.status(400).json({ message: 'This transaction already failed. Start a new checkout.' });
  }

  // Mock mode is a server-side fact. When real keys are configured, the
  // signature is always verified — there is no client-controlled bypass.
  if (!isMockMode()) {
    if (transaction.razorpay_order_id !== razorpayOrderId) {
      return res.status(400).json({ message: 'Order mismatch' });
    }
    if (!verifySignature(razorpayOrderId, razorpayPaymentId, razorpaySignature)) {
      await db.from('transactions').update({ status: 'failed' }).eq('id', transaction.id);
      return res.status(400).json({ message: 'Payment verification failed' });
    }
  }

  const activated = await activateSubscription(db, transaction, {
    paymentId: razorpayPaymentId || 'mock_payment',
    signature: razorpaySignature || ''
  });

  /*
   * The webhook got there first, in the window between the status check above
   * and this write. Nothing is wrong from the caller's point of view -- the
   * subscription is active -- so this answers exactly as the already-verified
   * branch does rather than inventing an error for a payment that worked.
   */
  if (!activated) {
    return res.json({
      message: 'Payment already verified',
      subscription: { plan: transaction.plan }
    });
  }

  const { user, expiresAt } = activated;

  await emailInvoice(user, transaction, expiresAt);

  res.json({
    message: 'Payment verified! Subscription activated.',
    subscription: {
      plan: user.subscription_plan,
      expiresAt: user.subscription_expires_at
    }
  });
}, 'Could not verify that payment'));

/**
 * POST /api/subscriptions/webhook — Razorpay server-to-server callback.
 *
 * Without this, payment confirmation depended entirely on the user's browser
 * calling /verify-payment: if they closed the tab after paying, the money was
 * captured and the subscription was never granted, with no way to repair it.
 *
 * Mounted with express.raw() in index.js — HMAC must be computed over the exact
 * bytes Razorpay signed, and express.json() would have already re-serialized them.
 * Deliberately NOT behind `protect`: the caller is Razorpay, not a logged-in user.
 * The signature IS the authentication.
 */
router.post('/webhook', async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ message: 'Webhook not configured' });

  const signature = req.headers['x-razorpay-signature'];
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));

  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature || ''), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(400).json({ message: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ message: 'Malformed payload' });
  }

  // Acknowledge fast; Razorpay retries on non-2xx and we don't want a slow
  // Supabase call to trigger duplicate deliveries.
  res.json({ received: true });

  try {
    if (event.event !== 'payment.captured' && event.event !== 'order.paid') return;

    const payment = event.payload?.payment?.entity || {};
    const orderId = payment.order_id || event.payload?.order?.entity?.id;
    if (!orderId) return;

    const db = getSupabase();
    const { data: transaction } = await db
      .from('transactions')
      .select('*')
      .eq('razorpay_order_id', orderId)
      .maybeSingle();

    if (!transaction || transaction.status === 'success') return;

    const activated = await activateSubscription(db, transaction, {
      paymentId: payment.id || '',
      signature: 'webhook'
    });

    // The browser callback won the race. It has already activated and emailed.
    if (!activated) return;

    const { user, expiresAt } = activated;
    await emailInvoice(user, transaction, expiresAt);
    console.log(`[webhook] activated ${transaction.plan} for user ${transaction.user_id}`);
  } catch (err) {
    console.error('[webhook] activation failed:', err.message);
  }
});

// GET /api/subscriptions/history
router.get('/history', protect, asyncHandler(async (req, res) => {
  const { data, error } = await getSupabase()
    .from('transactions')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });

  if (error) throw error;
  res.json({ transactions: (data || []).map(shapeTransaction) });
}, 'Could not load billing history'));

// index.js mounts this router directly, so the router must be the export itself.
// isMockMode rides along as a property for the tests and the cron sweep.
module.exports = router;
module.exports.isMockMode = isMockMode;
/*
 * Exported for tests. The race this guards cannot be reproduced through the
 * routes: both callers re-read the transaction first, so the second one hits
 * the already-verified early return and the conditional update never fires.
 * Calling this directly with a stale transaction is what actually exercises it.
 */
module.exports.activateSubscription = activateSubscription;
