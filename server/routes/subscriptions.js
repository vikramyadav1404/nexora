const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { getSupabase } = require('../db/supabase');
const { shapeTransaction } = require('../db/helpers');
const { protect } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');

const PLANS = {
  bronze: { price: 10000, name: 'Bronze', description: '5 questions/day' },
  silver: { price: 30000, name: 'Silver', description: '10 questions/day' },
  gold: { price: 100000, name: 'Gold', description: 'Unlimited questions/day' }
};

const getRazorpay = () => {
  if (!process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID === 'rzp_test_YOUR_KEY_ID') {
    return null;
  }
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
};

// Payment window is always open (restriction removed for demo / easier testing).
// Set PAYMENT_WINDOW_ENFORCED=true in .env to re-enable 10:00–11:00 AM IST only.
const isPaymentWindowOpen = () => {
  if (process.env.PAYMENT_WINDOW_ENFORCED === 'true') {
    const now = new Date();
    const istDate = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    const hour = istDate.getUTCHours();
    return hour === 10;
  }
  return true;
};

// GET /api/subscriptions/plans
router.get('/plans', (req, res) => {
  res.json({ plans: PLANS, windowOpen: isPaymentWindowOpen() });
});

// POST /api/subscriptions/create-order
router.post('/create-order', protect, async (req, res) => {
  try {
    if (!isPaymentWindowOpen()) {
      const istDate = new Date(new Date().getTime() + (5.5 * 60 * 60 * 1000));
      const currentHour = istDate.getUTCHours();
      return res.status(403).json({
        message: `⏰ Payments are only accepted between 10:00 AM - 11:00 AM IST. Current IST time: ${currentHour}:${String(istDate.getUTCMinutes()).padStart(2, '0')}`,
        windowOpen: false,
        currentIST: istDate.toISOString()
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
      orderId = `order_mock_${Date.now()}`;
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
      isMock: !razorpay
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/subscriptions/verify-payment
router.post('/verify-payment', protect, async (req, res) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature, transactionId, plan, isMock } = req.body;
    const db = getSupabase();

    const { data: transaction } = await db.from('transactions').select('*').eq('id', transactionId).maybeSingle();
    if (!transaction) return res.status(404).json({ message: 'Transaction not found' });

    let isValid = false;
    if (isMock || !process.env.RAZORPAY_KEY_SECRET || process.env.RAZORPAY_KEY_SECRET === 'YOUR_KEY_SECRET') {
      isValid = true;
    } else {
      const body = razorpayOrderId + '|' + razorpayPaymentId;
      const expectedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(body).digest('hex');
      isValid = expectedSignature === razorpaySignature;
    }

    if (!isValid) {
      await db.from('transactions').update({ status: 'failed' }).eq('id', transaction.id);
      return res.status(400).json({ message: 'Payment verification failed' });
    }

    await db.from('transactions').update({
      status: 'success',
      razorpay_payment_id: razorpayPaymentId || 'mock_payment',
      razorpay_signature: razorpaySignature || 'mock_sig'
    }).eq('id', transaction.id);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const { data: user, error } = await db.from('users').update({
      subscription_plan: plan,
      subscription_expires_at: expiresAt.toISOString()
    }).eq('id', req.user.id).select().single();

    if (error) throw error;

    const planInfo = PLANS[plan];
    await sendEmail(
      user.email,
      `Nexora Invoice - ${planInfo.name} Plan`,
      `
      <div style="font-family: Arial; max-width: 600px; margin: auto; background: #1a1a2e; color: #fff; padding: 30px; border-radius: 12px;">
        <h2 style="color: #6c63ff;">🧾 Nexora Payment Invoice</h2>
        <p>Invoice #${transaction.invoice_number}</p>
        <p>Plan: ${planInfo.name}</p>
        <p>Amount: ₹${planInfo.price / 100}</p>
        <p>Valid Until: ${expiresAt.toLocaleDateString('en-IN')}</p>
      </div>
      `
    );

    res.json({
      message: 'Payment verified! Subscription activated.',
      subscription: {
        plan: user.subscription_plan,
        expiresAt: user.subscription_expires_at
      }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/subscriptions/history
router.get('/history', protect, async (req, res) => {
  try {
    const { data, error } = await getSupabase()
      .from('transactions')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ transactions: (data || []).map(shapeTransaction) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
