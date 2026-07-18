import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';
import { Mail, Lock, User, Phone, Eye, EyeOff, UserPlus } from 'lucide-react';

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '', confirm: '' });
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (form.password !== form.confirm) { setError('Passwords do not match'); return; }
    if (form.password.length < 6) { setError('Password must be at least 6 characters'); return; }
    setLoading(true);
    try {
      await register(form.name, form.email, form.phone, form.password);
      toast.success('Welcome to Nexora! 🎉');
      navigate('/feed');
    } catch (err) {
      setError(err.response?.data?.message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card animate-slideUp">
        <div className="auth-logo">
          <h1>⬡ Nexora</h1>
          <p>Create your account and start connecting!</p>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Full Name</label>
            <div className="input-wrapper">
              <User size={16} className="input-icon" />
              <input type="text" className="form-input" placeholder="John Doe" value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })} required />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Email</label>
            <div className="input-wrapper">
              <Mail size={16} className="input-icon" />
              <input type="email" className="form-input" placeholder="you@example.com" value={form.email}
                onChange={e => setForm({ ...form, email: e.target.value })} required />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Phone (optional)</label>
            <div className="input-wrapper">
              <Phone size={16} className="input-icon" />
              <input type="tel" className="form-input" placeholder="+91 98765 43210" value={form.phone}
                onChange={e => setForm({ ...form, phone: e.target.value })} />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Password</label>
            <div className="input-wrapper" style={{ position: 'relative' }}>
              <Lock size={16} className="input-icon" />
              <input type={showPw ? 'text' : 'password'} className="form-input" placeholder="Min 6 characters"
                value={form.password} onChange={e => setForm({ ...form, password: e.target.value })}
                style={{ paddingLeft: 42, paddingRight: 42 }} required />
              <button type="button" onClick={() => setShowPw(!showPw)} style={{
                position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)'
              }}>
                {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Confirm Password</label>
            <div className="input-wrapper">
              <Lock size={16} className="input-icon" />
              <input type="password" className="form-input" placeholder="Repeat password" value={form.confirm}
                onChange={e => setForm({ ...form, confirm: e.target.value })} required />
            </div>
          </div>
          <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={loading}>
            {loading ? <><div className="spinner" /> Creating account...</> : <><UserPlus size={16} /> Create Account</>}
          </button>
        </form>
        <div className="divider" />
        <p style={{ textAlign: 'center', fontSize: 14, color: 'var(--text-muted)' }}>
          Already have an account?{' '}
          <Link to="/login" style={{ color: 'var(--primary-light)', fontWeight: 600 }}>Sign In</Link>
        </p>
      </div>
    </div>
  );
}
