import { useNavigate } from 'react-router-dom';
import { Rss, HelpCircle, Star, Users, Globe, CreditCard, ChevronRight, Zap, Shield, Award } from 'lucide-react';

export default function Landing() {
  const navigate = useNavigate();

  return (
    <div style={{ minHeight: '100vh' }}>
      {/* Hero */}
      <section className="hero-section">
        {/* Floating orbs */}
        <div style={{
          position: 'absolute', top: '20%', left: '10%', width: 300, height: 300,
          borderRadius: '50%', background: 'radial-gradient(circle, rgba(124,58,237,0.15) 0%, transparent 70%)',
          animation: 'float 6s ease-in-out infinite', pointerEvents: 'none'
        }} />
        <div style={{
          position: 'absolute', bottom: '20%', right: '10%', width: 200, height: 200,
          borderRadius: '50%', background: 'radial-gradient(circle, rgba(6,182,212,0.12) 0%, transparent 70%)',
          animation: 'float 8s ease-in-out infinite reverse', pointerEvents: 'none'
        }} />

        <div className="animate-fadeIn" style={{ position: 'relative', zIndex: 1 }}>
          {/* Badge */}
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '6px 16px', borderRadius: 'var(--radius-full)',
            background: 'rgba(124,58,237,0.15)', border: '1px solid rgba(124,58,237,0.3)',
            fontSize: 13, color: 'var(--primary-light)', marginBottom: 24,
            animation: 'glow 3s ease-in-out infinite'
          }}>
            <Zap size={14} /> The Future of Community Learning
          </div>

          <h1 className="hero-title">
            Connect. Learn.{' '}
            <span className="text-gradient">Grow Together.</span>
          </h1>

          <p className="hero-subtitle">
            Nexora is your all-in-one community platform — share ideas on the social feed,
            get answers to your questions, earn rewards, and level up your knowledge.
          </p>

          <div className="hero-cta">
            <button className="btn btn-primary btn-lg" onClick={() => navigate('/register')}>
              Get Started Free <ChevronRight size={18} />
            </button>
            <button className="btn btn-secondary btn-lg" onClick={() => navigate('/login')}>
              Sign In
            </button>
          </div>

          {/* Stats */}
          <div style={{ display: 'flex', gap: 40, justifyContent: 'center', marginTop: 60, flexWrap: 'wrap' }}>
            {[
              { label: 'Community Members', value: '10K+' },
              { label: 'Questions Answered', value: '50K+' },
              { label: 'Points Distributed', value: '500K+' },
              { label: 'Languages', value: '6' }
            ].map(s => (
              <div key={s.label} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 28, fontWeight: 800, fontFamily: 'var(--font-heading)', background: 'var(--gradient-primary)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>{s.value}</div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section style={{ padding: '80px 24px', maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: 48 }}>
          <h2 style={{ fontSize: 36, fontFamily: 'var(--font-heading)', marginBottom: 12 }}>
            Everything you need in <span className="text-gradient">one place</span>
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 16 }}>Powerful features designed for modern communities</p>
        </div>

        <div className="hero-features">
          {[
            {
              icon: <Rss size={24} color="white" />,
              title: 'Social Feed',
              desc: 'Share posts with images & videos. Like, comment, share. Daily post limits based on your friend network.',
              color: '#7c3aed'
            },
            {
              icon: <HelpCircle size={24} color="white" />,
              title: 'Q&A System',
              desc: 'Ask questions, get expert answers. Upvote the best answers. Subscription plans for power users.',
              color: '#06b6d4'
            },
            {
              icon: <Star size={24} color="white" />,
              title: 'Reward Points',
              desc: 'Earn points for contributing. Transfer points to others. Unlock Bronze, Silver, and Gold badges.',
              color: '#f59e0b'
            },
            {
              icon: <Users size={24} color="white" />,
              title: 'Friend Network',
              desc: 'Connect with like-minded people. Your friend count determines your daily posting capacity.',
              color: '#ec4899'
            },
            {
              icon: <CreditCard size={24} color="white" />,
              title: 'Subscription Plans',
              desc: 'Free to Bronze, Silver, and Gold. More questions per day. Razorpay secure payments.',
              color: '#10b981'
            },
            {
              icon: <Globe size={24} color="white" />,
              title: 'Multi-Language',
              desc: 'Use Nexora in 6 languages: English, Hindi, Spanish, Portuguese, Chinese, and French.',
              color: '#6366f1'
            }
          ].map(f => (
            <div key={f.title} className="feature-card" style={{ cursor: 'default' }}>
              <div className="feature-icon" style={{ background: `linear-gradient(135deg, ${f.color}, ${f.color}aa)` }}>
                {f.icon}
              </div>
              <h3>{f.title}</h3>
              <p>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Plans preview */}
      <section style={{ padding: '80px 24px', background: 'rgba(255,255,255,0.02)', borderTop: '1px solid var(--bg-glass-border)', borderBottom: '1px solid var(--bg-glass-border)' }}>
        <div style={{ maxWidth: 900, margin: '0 auto', textAlign: 'center' }}>
          <h2 style={{ fontSize: 32, fontFamily: 'var(--font-heading)', marginBottom: 12 }}>
            Choose Your <span className="text-gradient-gold">Plan</span>
          </h2>
          <p style={{ color: 'var(--text-muted)', marginBottom: 48 }}>Unlock more questions per day with a premium plan</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 20 }}>
            {[
              { name: 'Free', price: '₹0', qs: '1 Q/day', cls: '' },
              { name: 'Bronze', price: '₹100', qs: '5 Q/day', cls: 'bronze' },
              { name: 'Silver', price: '₹300', qs: '10 Q/day', cls: 'silver' },
              { name: 'Gold', price: '₹1000', qs: 'Unlimited', cls: 'gold' }
            ].map(p => (
              <div key={p.name} className={`plan-card ${p.cls}`} style={{ padding: '20px 16px' }}>
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>{p.name}</div>
                <div className="plan-price" style={{ fontSize: 28 }}>{p.price}<span>/mo</span></div>
                <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 8 }}>{p.qs}</div>
              </div>
            ))}
          </div>
          <button className="btn btn-primary btn-lg" style={{ marginTop: 32 }} onClick={() => navigate('/register')}>
            Start Free Today
          </button>
        </div>
      </section>

      {/* Footer */}
      <footer style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
        <div className="navbar-brand" style={{ justifyContent: 'center', marginBottom: 16 }}>
          <svg width="20" height="20" viewBox="0 0 28 28" fill="none">
            <polygon points="14,2 26,8 26,20 14,26 2,20 2,8" fill="url(#nf)"/>
            <defs><linearGradient id="nf" x1="0" y1="0" x2="28" y2="28"><stop offset="0%" stopColor="#7c3aed"/><stop offset="100%" stopColor="#06b6d4"/></linearGradient></defs>
          </svg>
          Nexora
        </div>
        <p>© 2024 Nexora. Built with ❤️ for communities worldwide.</p>
      </footer>
    </div>
  );
}
