import { useState, useEffect } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { Check, Clock, CreditCard, Zap, Star, Shield, AlertTriangle, ChevronRight, Receipt } from 'lucide-react';

const PLANS = [
  {
    id: 'free', name: 'Free', price: 0, color: '#6b7280',
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
  const [windowOpen, setWindowOpen] = useState(false);
  const [currentIST, setCurrentIST] = useState('');
  const [transactions, setTransactions] = useState([]);
  const [tab, setTab] = useState('plans');

  useEffect(() => {
    checkWindow();
    fetchHistory();
    const interval = setInterval(checkWindow, 30000);
    return () => clearInterval(interval);
  }, []);

  const checkWindow = async () => {
    try {
      const res = await axios.get('/api/subscriptions/plans');
      setWindowOpen(res.data.windowOpen);
      // Compute current IST time
      const now = new Date();
      const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
      setCurrentIST(ist.toUTCString().split(' ')[4] + ' IST');
    } catch {}
  };

  const fetchHistory = async () => {
    try {
      const res = await axios.get('/api/subscriptions/history');
      setTransactions(res.data.transactions);
    } catch {}
  };

  const handleSubscribe = async (planId) => {
    if (planId === 'free') { toast('You are already on the Free plan'); return; }
    if (user?.subscription?.plan === planId) { toast('You are already on this plan!'); return; }

    if (!windowOpen) {
      toast.error('⏰ Payments are only accepted between 10:00 AM - 11:00 AM IST');
      return;
    }

    setLoading(true);
    try {
      const res = await axios.post('/api/subscriptions/create-order', { plan: planId });
      const { orderId, amount, keyId, transactionId, isMock } = res.data;

      if (isMock) {
        // Demo mode: auto-verify without Razorpay
        await axios.post('/api/subscriptions/verify-payment', {
          razorpayOrderId: orderId,
          razorpayPaymentId: `mock_pay_${Date.now()}`,
          razorpaySignature: 'mock_signature',
          transactionId,
          plan: planId,
          isMock: true
        });
        toast.success(`🎉 Subscribed to ${planId.toUpperCase()} plan! (Demo mode)`);
        refreshUser();
        fetchHistory();
        return;
      }

      // Real Razorpay checkout
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
              transactionId,
              plan: planId
            });
            toast.success('🎉 Payment successful! Subscription activated.');
            refreshUser();
            fetchHistory();
          } catch { toast.error('Payment verification failed'); }
        },
        prefill: { name: user?.name, email: user?.email },
        theme: { color: '#7c3aed' }
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

  return (
    <div className="page-container">
      <div className="content-wrapper" style={{ maxWidth: 1000 }}>
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <h1 style={{ fontSize: 36, fontFamily: 'var(--font-heading)', marginBottom: 10 }}>
            Choose Your <span className="text-gradient-gold">Plan</span>
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 16 }}>
            Unlock more features and questions per day
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
            {/* Current plan info */}
            {currentPlan !== 'free' && expiresAt && (
              <div className="alert alert-success" style={{ maxWidth: 500, margin: '0 auto 24px', justifyContent: 'center' }}>
                <Shield size={16} />
                Active: <strong>{currentPlan.toUpperCase()}</strong> plan · Expires {new Date(expiresAt).toLocaleDateString('en-IN')}
              </div>
            )}

            {/* Payment window warning */}
            {!windowOpen && (
              <div className="time-window-banner" style={{ maxWidth: 600, margin: '0 auto 24px' }}>
                <Clock size={20} />
                <div>
                  <strong>Payment Window Closed</strong>
                  <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>
                    Payments are only accepted between <strong>10:00 AM - 11:00 AM IST</strong>.
                    Current time: <strong>{currentIST}</strong>
                  </p>
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
                    ℹ️ In demo mode, you can still proceed with mock payment.
                  </p>
                </div>
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
                        background: 'var(--gradient-primary)', color: 'white', padding: '4px 16px',
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

                    <button
                      className={`btn ${isCurrent ? 'btn-secondary' : 'btn-primary'}`}
                      style={{ width: '100%', ...(isCurrent ? {} : { background: `linear-gradient(135deg, ${plan.color}88, ${plan.color})` }) }}
                      onClick={() => handleSubscribe(plan.id)}
                      disabled={loading || isCurrent}
                    >
                      {isCurrent ? <><Check size={15} /> Current Plan</> : <><Zap size={15} /> {plan.price === 0 ? 'Downgrade' : 'Subscribe'}</>}
                    </button>
                  </div>
                );
              })}
            </div>

            <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--text-muted)' }}>
              <AlertTriangle size={14} style={{ display: 'inline', marginRight: 4 }} />
              Subscriptions auto-expire after 30 days. Invoice sent to your email after payment.
            </div>
          </>
        )}

        {tab === 'history' && (
          <div style={{ maxWidth: 600, margin: '0 auto' }}>
            {transactions.length === 0 ? (
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
                        background: tx.status === 'success' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
                        color: tx.status === 'success' ? 'var(--success)' : 'var(--danger)',
                        border: `1px solid ${tx.status === 'success' ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`
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
