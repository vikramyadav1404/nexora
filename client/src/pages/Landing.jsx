import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import toast from 'react-hot-toast';
import { Eye, EyeOff } from 'lucide-react';

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
    <div className="fb-landing">
      <div className="fb-landing-main">
        <div className="fb-landing-copy">
          <div className="fb-landing-logo">nexora</div>
          <p className="fb-landing-tagline">
            Connect with friends and the world around you on Nexora.
          </p>
        </div>

        <div>
          <div className="fb-landing-card animate-slideUp">
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
              <Link to="/forgot-password" style={{ fontSize: 14, color: 'var(--fb-blue)', fontWeight: 500 }}>
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

          <p style={{
            textAlign: 'center', marginTop: 28, fontSize: 14, color: 'var(--text-base)',
            maxWidth: 396, marginLeft: 'auto', marginRight: 'auto'
          }}>
            <strong>Create a Page</strong> for a celebrity, brand or business.
          </p>
        </div>
      </div>

      <footer className="fb-landing-footer">
        English (UK) · हिन्दी · Español · Português · 中文 · Français
        <div style={{ marginTop: 12 }}>
          © {new Date().getFullYear()} Nexora
        </div>
      </footer>
    </div>
  );
}
