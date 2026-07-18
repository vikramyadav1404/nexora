import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';
import { Eye, EyeOff } from 'lucide-react';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', password: '' });
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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
                  id="login-email"
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
                  id="login-password"
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
                    background: 'none', border: 'none', cursor: 'pointer', color: '#8A8D91',
                    display: 'flex', padding: 0
                  }}
                >
                  {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>

              <button
                id="login-submit"
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
        </div>
      </div>

      <footer className="fb-landing-footer">
        © {new Date().getFullYear()} Nexora
      </footer>
    </div>
  );
}
