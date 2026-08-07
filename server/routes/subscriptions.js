const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { getSupabase } = require('../db/supabase');
const { shapeTransaction, getActivePlan } = require('../db/helpers');
const { protect } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');
const { sendError, asyncHandler } = require('../utils/respond');

const PLANS = {
  bronze: { price: 10000, name: 'Bronze', description: '5 questions/day' },
  silver: { price: 30000, name: 'Silver', description: '10 questions/day' },
  gold: { price: 100000, name: 'Gold', description: 'Unlimited questions/day' }
};

const PLAN_DAYS = 30;
const TRIAL_DAYS = 2;

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
/**
 * Where a payment's PLAN_DAYS are added on from.
 *
 * Renewing must not throw away time already paid for. Someone with 10 days
 * left who buys another month should end up with 40 days, not 30 — the old
 * behaviour computed `now + PLAN_DAYS` flat and silently ate the remainder.
 *
 * Note what this gives up. That flat value was load-bearing: it meant a double
 * activation could not extend anything, because writing `now + 30` twice lands
 * on the same date. Adding to the existing expiry removes that safety net, so a
 * double activation would now genuinely hand out 60 days.
 *
 * That is only acceptable because activateSubscription already refuses to run
 * twice — the .eq('status', 'pending') claim below, plus the unique index on
 * razorpay_payment_id from migration 013. This function is why those two matter
 * more than they did yesterday, and why the concurrency tests must keep passing.
 *
 * An expiry in the past is ignored: a lapsed subscription starts from today,
 * not from whenever it ran out.
 */
function extendFrom(currentExpiry, days) {
  const now = Date.now();
  const base = currentExpiry ? new Date(currentExpiry).getTime() : now;
  const start = new Date(Math.max(now, base));
  start.setDate(start.getDate() + days);
  return start;
}

async function activateSubscription(db, transaction, { paymentId, signature }) {
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

  /*
   * Read the current expiry only after winning the claim above, so this cannot
   * run twice for one payment.
   *
   * Time stacks only when renewing the same plan. Buying a different plan
   * starts a fresh PLAN_DAYS from today — that is a switch, not a renewal, and
   * carrying the remainder across tiers means 10 days of Gold could be turned
   * into 10 extra days of Bronze.
   */
  const { data: before, error: readErr } = await db.from('users')
    .select('subscription_plan, subscription_expires_at')
    .eq('id', transaction.user_id)
    .single();

  if (readErr) throw readErr;

  const renewingSamePlan = getActivePlan(before) === transaction.plan;
  const expiresAt = extendFrom(renewingSamePlan ? before.subscription_expires_at : null, PLAN_DAYS);

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

  /*
   * The mock id has to be unique per transaction, not the literal string
   * 'mock_payment'.
   *
   * Migration 013 put a unique index on razorpay_payment_id (for non-empty
   * values), so a constant meant the first mock payment claimed that value
   * forever and every later one failed the insert -- a 500 on every checkout
   * once one mock payment existed. The index did not cause the bug so much as
   * expose it: duplicate payment ids were always wrong, they were just silent.
   *
   * transaction.id rather than a timestamp, because it is already unique and
   * deterministic -- retrying the same transaction produces the same value
   * instead of littering the table with near-identical ids.
   */
  const activated = await activateSubscription(db, transaction, {
    paymentId: razorpayPaymentId || `mock_${transaction.id}`,
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
/**
 * POST /api/subscriptions/cancel
 *
 * Downgrades to free immediately, forfeiting whatever time is left.
 *
 * There is no recurring billing to stop. A payment buys PLAN_DAYS of access and
 * getActivePlan() drops back to 'free' on its own once subscription_expires_at
 * passes — nothing renews, no card is stored, and no Razorpay subscription
 * exists. So this is not "stop charging me"; it is "end it now".
 *
 * That distinction is the whole reason the response reports daysForfeited and
 * the UI says it out loud before asking for confirmation. Someone clicking
 * Cancel usually wants to stop a future charge, and here there isn't one — they
 * would be giving up paid days for nothing.
 *
 * No refund is issued. Razorpay refunds are real money movement and need a
 * stated policy; this endpoint deliberately does not pretend to handle that.
 */
/**
 * POST /api/subscriptions/trial
 *
 * Two free days of a paid plan. Once per account, ever.
 *
 * No payment and no card, because there is nowhere to store one — so nothing
 * converts automatically when the two days run out. The trial simply expires
 * and the user is back on free, exactly as a paid plan does. If they want to
 * continue they pay, deliberately, through the normal checkout.
 *
 * "Once, ever" is carried by users.trial_used_at (migration 014) rather than by
 * subscription state, because subscription state cannot answer it: an expired
 * trial leaves the user on 'free', which looks identical to someone who never
 * trialled. Cancelling mid-trial looks identical too. The column is never
 * cleared — not by cancelling, not by expiry, not by paying.
 */
/*
 * Split out for the same reason as cancelSubscription: protect re-reads the
 * user, so a second request through the route sees the stamp and stops at the
 * early check — the conditional write below is unreachable from there, and a
 * test driven through the route passes with it deleted. Calling this twice with
 * one stale row is the actual window.
 *
 * Returns { refused } for a rule, null for a lost race, or the granted expiry.
 */
async function startTrialFor(db, row, plan) {
  if (!PLANS[plan]) return { refused: 'unknown_plan' };

  // Starting a trial on top of a plan they are paying for would replace paid
  // time with free time -- strictly worse for them, so refuse it.
  if (getActivePlan(row) !== 'free') return { refused: 'active_plan' };

  /*
   * No early `if (row.trial_used_at)` check here on purpose.
   *
   * There was one, and deleting it failed no test -- because the conditional
   * write below already refuses, returns null, and the route maps that to the
   * same "already used your free trial" response. It was a second branch
   * producing an identical outcome, so it could never be proven by a test and
   * could drift from the real guard. The write is the single source of truth.
   */

  const expiresAt = extendFrom(null, TRIAL_DAYS);

  /*
   * .is('trial_used_at', null) is the guard, and it is the whole feature.
   *
   * Two requests arriving together both read a null trial_used_at and both
   * decide the account is eligible. Without a condition on the write, both
   * succeed and the second silently grants another two days -- repeat and the
   * trial is unlimited. Matching on null means exactly one write lands.
   */
  const { data: claimed, error } = await db.from('users').update({
    subscription_plan: plan,
    subscription_expires_at: expiresAt.toISOString(),
    trial_used_at: new Date().toISOString()
  })
    .eq('id', row.id)
    .is('trial_used_at', null)
    .select('id');

  /*
   * PGRST204 means trial_used_at does not exist yet -- migration 014 has not
   * been applied to this database. Without this branch the route 500s and the
   * user is told nothing useful. "Not available" is true, and it keeps
   * deploying the code before the migration harmless rather than broken.
   */
  if (error) {
    if (error.code === 'PGRST204') return { refused: 'no_column' };
    throw error;
  }

  if (!claimed || claimed.length === 0) return null;
  return { expiresAt };
}

router.post('/trial', protect, asyncHandler(async (req, res) => {
  const plan = String(req.body?.plan || '').toLowerCase();
  const result = await startTrialFor(getSupabase(), req.userRow, plan);

  const refusals = {
    unknown_plan: [400, 'Unknown plan'],
    already_used: [400, 'You have already used your free trial'],
    active_plan: [400, 'You already have an active plan'],
    no_column: [503, 'Free trials are not available yet']
  };

  if (result && result.refused) {
    const [status, message] = refusals[result.refused];
    return res.status(status).json({ message });
  }

  // Lost the race against a simultaneous request from the same account.
  if (result === null) {
    return res.status(400).json({ message: 'You have already used your free trial' });
  }

  res.json({
    message: `Your ${PLANS[plan].name} trial has started. It runs for ${TRIAL_DAYS} days.`,
    subscription: { plan, expiresAt: result.expiresAt.toISOString() },
    trialDays: TRIAL_DAYS,
    isTrial: true
  });
}, 'Could not start that trial'));

/*
 * Split out from the route for the same reason activateSubscription was: the
 * race lives between one caller's read of the user row and its write, and a
 * test driven through the route cannot reach it — protect re-reads the user, so
 * a second request sees 'free' and stops at the early check. Calling this twice
 * with the same stale row is that window exactly.
 *
 * Returns null when another caller got there first.
 */
async function cancelSubscription(db, row) {
  // getActivePlan, not the raw column: a plan whose expiry has already passed
  // is free in every way that matters, and cancelling it is a no-op.
  const active = getActivePlan(row);
  if (active === 'free') return { refused: 'not_paid' };

  const expiresAt = row.subscription_expires_at ? new Date(row.subscription_expires_at) : null;
  const daysForfeited = expiresAt
    ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 86400000))
    : 0;

  /*
   * Conditional on the plan still being what we read.
   *
   * Two tabs both clicking Cancel would otherwise both "succeed", and a Cancel
   * racing a fresh purchase could wipe a plan the user just paid for. Matching
   * on subscription_plan means only one wins.
   */
  const { data: changed, error } = await db.from('users').update({
    subscription_plan: 'free',
    subscription_expires_at: null
  })
    .eq('id', row.id)
    .eq('subscription_plan', active)
    .select('id');

  if (error) throw error;
  if (!changed || changed.length === 0) return null;

  return { cancelledPlan: active, daysForfeited };
}

router.post('/cancel', protect, asyncHandler(async (req, res) => {
  const result = await cancelSubscription(getSupabase(), req.userRow);

  if (result && result.refused === 'not_paid') {
    return res.status(400).json({ message: 'You are not on a paid plan' });
  }

  if (result === null) {
    // Someone else got there first, or the plan changed underneath us.
    return res.json({
      message: 'Your subscription is already cancelled',
      subscription: { plan: 'free', expiresAt: null },
      daysForfeited: 0
    });
  }

  res.json({
    message: 'Subscription cancelled. You are back on the free plan.',
    subscription: { plan: 'free', expiresAt: null },
    cancelledPlan: result.cancelledPlan,
    daysForfeited: result.daysForfeited
  });
}, 'Could not cancel that subscription'));

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

/*
 * Same reasoning, same reason it must sit down here: module.exports is
 * reassigned to the router above, so any property attached before that line is
 * discarded. Adding this mid-file silently exported nothing.
 */
module.exports.cancelSubscription = cancelSubscription;
module.exports.startTrialFor = startTrialFor;

// extendFrom is exported to be unit-tested directly. Its Math.max branch is not
// reachable through activateSubscription -- a past expiry means getActivePlan
// returns 'free', so the caller passes null rather than the stale date -- and
// untestable code that claims to handle a case is worse than no code at all.
module.exports.extendFrom = extendFrom;
