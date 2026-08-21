import { useState, useEffect } from 'react';
import axios from '../services/api';
import useResource from '../hooks/useResource';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import { Check, Zap, Shield, AlertTriangle, Receipt, RefreshCw, Gift } from 'lucide-react';
import { ErrorState } from '../components/ui';

function loadRazorpayScript() {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) {
      resolve();
      return;
    }
    const existing = document.querySelector('script[data-nexora-razorpay]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Razorpay failed to load')));
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.dataset.nexoraRazorpay = '1';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Razorpay failed to load'));
    document.body.appendChild(script);
  });
}

const PLANS = [
  {
    id: 'free', name: 'Free', price: 0, color: 'var(--text-sub)',
    questions: 1, desc: 'Perfect for getting started',
    features: ['1 question/day', 'Unlimited answers', 'Basic rewards', 'Social feed']
  },
  {
    id: 'bronze', name: 'Bronze', price: 100, color: '#cd7f32',
    questions: 5, desc: 'For active learners',
    features: ['5 questions/day', 'Unlimited answers', 'Reward points', 'Social feed', 'Priority listing']
  },
  {
    id: 'silver', name: 'Silver', price: 300, color: '#c0c0c0',
    questions: 10, desc: 'For power users',
    features: ['10 questions/day', 'Unlimited answers', '2x reward points', 'Social feed', 'Priority listing', 'Profile badge'],
    popular: true
  },
  {
    id: 'gold', name: 'Gold', price: 1000, color: '#ffd700',
    questions: '∞', desc: 'Unlimited everything',
    features: ['Unlimited questions', 'Unlimited answers', '3x reward points', 'Social feed', 'Priority listing', 'Gold badge', 'Expert status']
  }
];

export default function Subscriptions() {
  const { user, refreshUser } = useAuth();
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('plans');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Null until /plans answers, so the buttons are not briefly enabled on load.
  const [paymentsAvailable, setPaymentsAvailable] = useState(null);

  // A swallowed failure left transactions empty, so "No transactions yet"
  // was shown to people who had in fact paid -- the worst version of this bug,
  // since it says the money was never taken.
  const historyRes = useResource(
    (signal) => axios.get('/api/subscriptions/history', { signal }).then(r => r.data.transactions || []),
    []
  );
  const transactions = historyRes.data || [];
  const fetchHistory = historyRes.reload;

  useEffect(() => {
    axios.get('/api/subscriptions/plans')
      .then(res => setPaymentsAvailable(res.data?.paymentsAvailable !== false))
      // An older API has no such field. Assume available rather than hiding
      // working buttons on a deployment that never had this problem.
      .catch(() => setPaymentsAvailable(true));
  }, []);

  const handleSubscribe = async (planId) => {
    if (planId === 'free') { toast('You are already on the Free plan'); return; }
    // Buying the plan you are already on is a renewal, not a mistake. The
    // server adds the days onto whatever is left rather than resetting, so
    // nothing is lost by renewing early -- this used to be refused outright.

    // Payment window no longer blocks subscribe (always open unless server enforces it)

    setLoading(true);
    try {
      const res = await axios.post('/api/subscriptions/create-order', { plan: planId });
      const { orderId, amount, keyId, transactionId, isMock } = res.data;

      if (isMock) {
        // Demo mode. Note the server decides this for itself from its Razorpay
        // config — sending isMock/plan from here would be ignored, so we don't.
        await axios.post('/api/subscriptions/verify-payment', {
          razorpayOrderId: orderId,
          transactionId
        });
        toast.success(`You're on ${planId} now (demo payment)`);
        refreshUser();
        fetchHistory();
        return;
      }

      // Real Razorpay checkout (script loaded on demand)
      await loadRazorpayScript();
      const options = {
        key: keyId,
        amount,
        currency: 'INR',
        name: 'Nexora',
        description: `${PLANS.find(p => p.id === planId)?.name} Plan - 1 Month`,
        order_id: orderId,
        handler: async (response) => {
          try {
            await axios.post('/api/subscriptions/verify-payment', {
              razorpayOrderId: response.razorpay_order_id,
              razorpayPaymentId: response.razorpay_payment_id,
              razorpaySignature: response.razorpay_signature,
              transactionId
            });
            toast.success('Payment went through — plan is active');
            refreshUser();
            fetchHistory();
          } catch { toast.error('Payment verification failed'); }
        },
        prefill: { name: user?.name, email: user?.email },
        theme: { color: 'var(--nx-violet)' }
      };
      const rzp = new window.Razorpay(options);
      rzp.open();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to initiate payment');
    } finally {
      setLoading(false);
    }
  };

  const currentPlan = user?.subscription?.plan || 'free';
  const expiresAt = user?.subscription?.expiresAt;

  // Same arithmetic the server uses, so the confirmation and the result agree.
  const daysLeft = expiresAt
    ? Math.max(0, Math.ceil((new Date(expiresAt) - Date.now()) / 86400000))
    : 0;

  // trialUsedAt is undefined until migration 014 lands, which reads as eligible
  // -- the same answer every existing account should get anyway.
  const trialUsed = !!user?.subscription?.trialUsedAt;
  const canTrial = currentPlan === 'free' && !trialUsed;

  const handleTrial = async (planId) => {
    setLoading(true);
    try {
      const res = await axios.post('/api/subscriptions/trial', { plan: planId });
      await refreshUser();
      toast.success(res.data?.message || 'Trial started');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not start that trial');
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async () => {
    setCancelling(true);
    try {
      const res = await axios.post('/api/subscriptions/cancel');
      await refreshUser();
      setConfirmCancel(false);
      toast.success(res.data?.message || 'Subscription cancelled');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not cancel that subscription');
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="page-container">
      <div className="content-wrapper" style={{ maxWidth: 1000 }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <h1 style={{ fontSize: 28, marginBottom: 8, fontWeight: 700 }}>
            Choose your plan
          </h1>
          <p style={{ color: 'var(--text-sub)', fontSize: 15 }}>
            Unlock more questions and features
          </p>
        </div>

        {/* Tab bar */}
        <div className="tab-bar" style={{ maxWidth: 300, margin: '0 auto 32px' }}>
          <button className={`tab-item ${tab === 'plans' ? 'active' : ''}`} onClick={() => setTab('plans')}>
            Plans
          </button>
          <button className={`tab-item ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>
            History
          </button>
        </div>

        {tab === 'plans' && (
          <>
            {/* Current plan info.
                Nothing here recurs -- a payment buys 30 days and the plan ends
                on its own. Saying so is the point: most people look for a
                Cancel button to stop a charge that, here, is never coming. */}
            {currentPlan !== 'free' && (
              <div className="alert alert-success" style={{ maxWidth: 500, margin: '0 auto 24px', flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <Shield size={16} />
                  <span>
                    Active: <strong>{currentPlan.toUpperCase()}</strong> plan
                    {expiresAt && <> · until {new Date(expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</>}
                  </span>
                </div>

                {!confirmCancel && (
                  <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--text-sub)' }}>
                    This does not renew automatically. Your plan simply ends on that date.
                    {' '}
                    <button
                      type="button"
                      onClick={() => setConfirmCancel(true)}
                      style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'var(--text-sub)', textDecoration: 'underline', cursor: 'pointer' }}
                    >
                      End it now
                    </button>
                  </div>
                )}

                {confirmCancel && (
                  <div style={{ textAlign: 'center', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, justifyContent: 'center', textAlign: 'left' }}>
                      <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 2 }} />
                      <span>
                        {daysLeft > 0 ? (
                          <>
                            You have <strong>{daysLeft} day{daysLeft === 1 ? '' : 's'}</strong> left that you
                            have already paid for. Ending now gives {daysLeft === 1 ? 'it' : 'them'} up and
                            there is no refund. Nothing is charged either way &mdash; if you just want the
                            billing to stop, it already has.
                          </>
                        ) : (
                          <>Ending now drops you to the free plan. There is no refund.</>
                        )}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => setConfirmCancel(false)} disabled={cancelling}>
                        Keep my plan
                      </button>
                      <button className="btn btn-danger btn-sm" onClick={handleCancel} disabled={cancelling}>
                        {cancelling ? 'Cancelling…' : 'End it now'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {paymentsAvailable === false && (
              <div className="alert alert-warning" style={{ maxWidth: 560, margin: '0 auto 24px', justifyContent: 'center', textAlign: 'center' }}>
                <AlertTriangle size={16} />
                Payments are being set up. Paid plans are unavailable for now — the free plan works as normal.
              </div>
            )}

            {/* Plans grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 20, marginBottom: 32 }}>
              {PLANS.map(plan => {
                const isCurrent = currentPlan === plan.id;
                return (
                  <div key={plan.id} className={`plan-card ${plan.id} ${plan.popular ? 'popular' : ''}`}
                    style={{ position: 'relative' }}>
                    {plan.popular && (
                      <div style={{
                        position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)',
                        background: 'var(--nx-gradient)', color: 'var(--text-on-accent)', padding: '4px 16px',
                        borderRadius: 'var(--radius-full)', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap'
                      }}>
                        ⭐ Most Popular
                      </div>
                    )}

                    <div style={{ fontSize: 28, marginBottom: 6 }}>
                      {plan.id === 'free' ? '🆓' : plan.id === 'bronze' ? '🥉' : plan.id === 'silver' ? '🥈' : '🥇'}
                    </div>
                    <h3 style={{ fontSize: 20, fontWeight: 800, color: plan.color }}>{plan.name}</h3>
                    <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>{plan.desc}</p>

                    <div className="plan-price" style={{ color: plan.color }}>
                      {plan.price === 0 ? 'Free' : `₹${plan.price}`}
                      {plan.price > 0 && <span>/month</span>}
                    </div>

                    <div style={{ fontSize: 14, fontWeight: 600, margin: '12px 0', color: plan.color }}>
                      {plan.questions === '∞' ? 'Unlimited' : `${plan.questions}`} questions/day
                    </div>

                    <div className="divider" />

                    <ul style={{ listStyle: 'none', marginBottom: 20, textAlign: 'left' }}>
                      {plan.features.map(f => (
                        <li key={f} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
                          <Check size={14} style={{ color: plan.color, flexShrink: 0 }} /> {f}
                        </li>
                      ))}
                    </ul>

                    {/* Renewing the plan you are on used to be refused. It is
                        now the main action for a current plan: the server adds
                        the days onto whatever is left, so renewing early costs
                        nothing. */}
                    <button
                      className="btn btn-primary"
                      style={{ width: '100%', background: `linear-gradient(135deg, ${plan.color}88, ${plan.color})` }}
                      onClick={() => handleSubscribe(plan.id)}
                      disabled={loading || plan.price === 0 || paymentsAvailable === false}
                    >
                      {/* Free is never "renewable" -- it does not expire and
                          costs nothing, so offering to renew it is nonsense. */}
                      {plan.price === 0
                        ? <><Check size={15} /> {isCurrent ? 'Your current plan' : 'Always free'}</>
                        : isCurrent
                          ? <><RefreshCw size={15} /> Renew for 30 days</>
                          : <><Zap size={15} /> Subscribe</>}
                    </button>

                    {canTrial && plan.price > 0 && (
                      <button
                        className="btn btn-secondary btn-sm"
                        style={{ width: '100%', marginTop: 8 }}
                        onClick={() => handleTrial(plan.id)}
                        disabled={loading}
                      >
                        <Gift size={14} /> Try free for 2 days
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' }}>
              <AlertTriangle size={14} style={{ display: 'inline', marginRight: 4 }} />
              Plans last 30 days and end on their own — nothing renews automatically and no card is stored.
              Renewing early is safe: the days are added to whatever is left, never replaced.
              {canTrial && ' The free trial runs for 2 days and can be used once.'}
              {' '}Invoice sent to your email after payment.
            </div>
          </>
        )}

        {tab === 'history' && (
          <div style={{ maxWidth: 600, margin: '0 auto' }}>
            {historyRes.isError ? (
              <ErrorState title="Could not load billing history" onRetry={historyRes.reload} />
            ) : transactions.length === 0 ? (
              <div className="empty-state">
                <Receipt size={48} style={{ margin: '0 auto 16px' }} />
                <h3>No transactions yet</h3>
                <p>Your payment history will appear here</p>
              </div>
            ) : (
              transactions.map(tx => (
                <div key={tx._id} className="glass-card" style={{ padding: 20, marginBottom: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <div style={{ width: 44, height: 44, borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22,
                      background: tx.plan === 'gold' ? 'rgba(255,215,0,0.1)' : tx.plan === 'silver' ? 'rgba(192,192,192,0.1)' : 'rgba(205,127,50,0.1)' }}>
                      {tx.plan === 'gold' ? '🥇' : tx.plan === 'silver' ? '🥈' : '🥉'}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, textTransform: 'capitalize' }}>{tx.plan} Plan</div>
                      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                        {new Date(tx.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>#{tx.invoiceNumber}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontWeight: 700, fontSize: 16 }}>₹{tx.amount}</div>
                      <span style={{
                        fontSize: 11, padding: '2px 8px', borderRadius: 'var(--radius-full)',
                        background: tx.status === 'success' ? 'var(--green-muted)' : 'var(--red-muted)',
                        color: tx.status === 'success' ? 'var(--success)' : 'var(--danger)',
                        border: `1px solid ${tx.status === 'success' ? 'var(--green-muted)' : 'var(--red-muted)'}`
                      }}>
                        {tx.status.toUpperCase()}
                      </span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
