import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';
import { Mail, Lock, Eye, EyeOff, LogIn } from 'lucide-react';

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
      await login(form.email, form.password);
      toast.success('Welcome back to Nexora! 🎉');
      navigate('/feed');
    } catch (err) {
      setError(err.response?.data?.message || 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card animate-slideUp">
        <div className="auth-logo">
          <h1>⬡ Nexora</h1>
          <p>Welcome back! Sign in to continue.</p>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Email</label>
            <div className="input-wrapper">
              <Mail size={16} className="input-icon" />
              <input
                type="email"
                className="form-input"
                placeholder="you@example.com"
                value={form.email}
                onChange={e => setForm({ ...form, email: e.target.value })}
                required
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Password</label>
            <div className="input-wrapper" style={{ position: 'relative' }}>
              <Lock size={16} className="input-icon" />
              <input
                type={showPw ? 'text' : 'password'}
                className="form-input"
                placeholder="Your password"
                value={form.password}
                onChange={e => setForm({ ...form, password: e.target.value })}
                style={{ paddingLeft: 42, paddingRight: 42 }}
                required
              />
              <button type="button" onClick={() => setShowPw(!showPw)} style={{
                position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)'
              }}>
                {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <div style={{ textAlign: 'right', marginBottom: 20 }}>
            <Link to="/forgot-password" style={{ fontSize: 13, color: 'var(--primary-light)' }}>
              Forgot Password?
            </Link>
          </div>

          <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={loading}>
            {loading ? <><div className="spinner" /> Signing in...</> : <><LogIn size={16} /> Sign In</>}
          </button>
        </form>

        <div className="divider" />
        <p style={{ textAlign: 'center', fontSize: 14, color: 'var(--text-muted)' }}>
          Don&apos;t have an account?{' '}
          <Link to="/register" style={{ color: 'var(--primary-light)', fontWeight: 600 }}>
            Create one free
          </Link>
        </p>
      </div>
    </div>
  );
}
