import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import toast from 'react-hot-toast';
import { Eye, EyeOff, Layers, MessageSquare, Trophy } from 'lucide-react';
import mark from '../assets/hero.png';

const PITCH = [
  {
    icon: Layers,
    title: 'Spaces, not a firehose',
    body: '16 interest communities. Pick yours at signup and your feed arrives already worth reading.'
  },
  {
    icon: MessageSquare,
    title: 'Questions that get resolved',
    body: 'Ask, answer, upvote, accept. The accepted answer sits at the top where the next person will find it.'
  },
  {
    icon: Trophy,
    title: 'Points you can actually spend',
    body: 'Earn them by helping. Send them to someone who helped you. Badges and streaks come along the way.'
  }
];

export default function Landing() {
  const { login, user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', password: '' });
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!authLoading && user) {
      navigate(user.onboardingCompleted ? '/feed' : '/onboarding', { replace: true });
    }
  }, [user, authLoading, navigate]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const user = await login(form.email, form.password);
      toast.success('Logged in');
      navigate(user?.onboardingCompleted ? '/feed' : '/onboarding');
    } catch (err) {
      setError(err.response?.data?.message || 'The email or password you entered is incorrect.');
    } finally {
      setLoading(false);
    }
  };

  if (authLoading || user) return null;

  return (
    <div className="auth-shell">
      <div className="auth-shell-main">
        <div className="auth-shell-copy">
          <img src={mark} alt="" className="auth-shell-mark" width="72" height="76" />
          <div className="auth-shell-logo">nexora</div>

          <h1 className="auth-shell-tagline">
            Build a network first.<br />
            <span className="auth-shell-accent">Then broadcast.</span>
          </h1>

          <p className="auth-shell-sub">
            Most feeds hand you a megaphone on day one. Nexora doesn&rsquo;t &mdash; your daily
            posting limit grows with the people you actually connect to. Show up, answer
            something, earn the room.
          </p>

          <ul className="auth-shell-points">
            {PITCH.map(({ icon: Icon, title, body }) => (
              <li key={title}>
                <span className="auth-shell-point-icon" aria-hidden="true">
                  <Icon size={18} />
                </span>
                <div>
                  <strong>{title}</strong>
                  <p>{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <div className="auth-shell-card animate-slideUp">
            {error && <div className="alert alert-error">{error}</div>}

            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <input
                  id="landing-email"
                  type="email"
                  className="form-input"
                  placeholder="Email address"
                  value={form.email}
                  onChange={e => setForm({ ...form, email: e.target.value })}
                  required
                  autoComplete="email"
                />
              </div>
              <div className="form-group" style={{ position: 'relative' }}>
                <input
                  id="landing-password"
                  type={showPw ? 'text' : 'password'}
                  className="form-input"
                  placeholder="Password"
                  value={form.password}
                  onChange={e => setForm({ ...form, password: e.target.value })}
                  required
                  autoComplete="current-password"
                  style={{ paddingRight: 44 }}
                />
                <button
                  type="button"
                  onClick={() => setShowPw(!showPw)}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                  style={{
                    position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)',
                    display: 'flex', padding: 0
                  }}
                >
                  {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>

              <button
                type="submit"
                className="btn btn-primary"
                style={{ width: '100%', height: 48, fontSize: 20, fontWeight: 700 }}
                disabled={loading}
              >
                {loading ? <div className="spinner" /> : 'Log In'}
              </button>
            </form>

            <div style={{ textAlign: 'center', marginTop: 14 }}>
              <Link to="/forgot-password" style={{ fontSize: 14, color: 'var(--nx-violet)', fontWeight: 500 }}>
                Forgotten password?
              </Link>
            </div>

            <div className="auth-create-wrap">
              <button
                type="button"
                className="btn-create"
                onClick={() => navigate('/register')}
                style={{ minWidth: 200 }}
              >
                Create new account
              </button>
            </div>
          </div>

          <p className="auth-shell-note">
            Free to join. Paid tiers only raise how many questions you can ask per day.
          </p>
        </div>
      </div>

      <footer className="auth-shell-footer">
        <Link to="/terms">Terms</Link>
        <span aria-hidden="true"> · </span>
        <Link to="/privacy">Privacy</Link>
        <div style={{ marginTop: 12 }}>
          © {new Date().getFullYear()} Nexora
        </div>
      </footer>
    </div>
  );
}
