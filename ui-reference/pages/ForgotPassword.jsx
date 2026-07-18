import { useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import toast from 'react-hot-toast';
import { Mail, Phone, RefreshCw, Key, ArrowLeft, Copy, Check } from 'lucide-react';

export default function ForgotPassword() {
  const [method, setMethod] = useState('email');
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [generatedPw, setGeneratedPw] = useState('');
  const [newPwResult, setNewPwResult] = useState('');
  const [copied, setCopied] = useState(false);

  const handleGenerate = async () => {
    try {
      const res = await axios.post('/api/auth/generate-password');
      setGeneratedPw(res.data.password);
    } catch {
      toast.error('Failed to generate password');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(''); setSuccess(''); setNewPwResult('');
    setLoading(true);
    try {
      const payload = method === 'email' ? { email: value } : { phone: value };
      const res = await axios.post('/api/auth/forgot-password', payload);
      setSuccess(res.data.message);
      if (res.data.devPassword) setNewPwResult(res.data.devPassword);
      toast.success('Password reset successful!');
    } catch (err) {
      const msg = err.response?.data?.message || 'Request failed';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card animate-slideUp" style={{ maxWidth: 480 }}>
        <div className="auth-logo">
          <h1>⬡ Nexora</h1>
          <p>Reset your password</p>
        </div>

        <Link to="/login" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>
          <ArrowLeft size={14} /> Back to Login
        </Link>

        <div className="tab-bar" style={{ marginBottom: 24 }}>
          <button className={`tab-item ${method === 'email' ? 'active' : ''}`} onClick={() => setMethod('email')}>📧 Email</button>
          <button className={`tab-item ${method === 'phone' ? 'active' : ''}`} onClick={() => setMethod('phone')}>📱 Phone</button>
        </div>

        {error && <div className="alert alert-error">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}

        {newPwResult && (
          <div className="alert alert-info" style={{ flexDirection: 'column', gap: 8 }}>
            <strong>🔑 Your new password (dev mode):</strong>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(0,0,0,0.2)', padding: '8px 12px', borderRadius: 8 }}>
              <code style={{ flex: 1, fontSize: 18, letterSpacing: 2 }}>{newPwResult}</code>
              <button onClick={() => { navigator.clipboard.writeText(newPwResult); toast.success('Copied!'); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--secondary)' }}>
                <Copy size={16} />
              </button>
            </div>
            <small style={{ color: 'var(--text-muted)' }}>Letters only, mixed case — no numbers or symbols</small>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">{method === 'email' ? 'Email Address' : 'Phone Number'}</label>
            <div className="input-wrapper">
              {method === 'email' ? <Mail size={16} className="input-icon" /> : <Phone size={16} className="input-icon" />}
              <input
                type={method === 'email' ? 'email' : 'tel'}
                className="form-input"
                placeholder={method === 'email' ? 'you@example.com' : '+91 98765 43210'}
                value={value}
                onChange={e => setValue(e.target.value)}
                required
              />
            </div>
          </div>
          <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={loading}>
            {loading ? <><div className="spinner" /> Sending...</> : <><Key size={16} /> Reset Password</>}
          </button>
        </form>

        {/* Password Generator Section */}
        <div style={{ marginTop: 32, padding: 20, background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.2)', borderRadius: 'var(--radius-lg)' }}>
          <h4 style={{ fontSize: 14, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
            <RefreshCw size={16} style={{ color: 'var(--primary-light)' }} /> Password Generator
          </h4>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
            Generate a random password with only letters (upper + lowercase). No numbers or special characters.
          </p>
          <button className="btn btn-secondary" style={{ width: '100%', marginBottom: 10 }} onClick={handleGenerate}>
            <RefreshCw size={15} /> Generate Random Password
          </button>
          {generatedPw && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(0,0,0,0.3)', padding: '10px 14px', borderRadius: 'var(--radius-md)' }}>
              <code style={{ flex: 1, fontSize: 20, letterSpacing: 3, color: 'var(--primary-light)' }}>{generatedPw}</code>
              <button onClick={() => { navigator.clipboard.writeText(generatedPw); setCopied(true); setTimeout(() => setCopied(false), 2000); toast.success('Copied!'); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied ? 'var(--success)' : 'var(--text-muted)' }}>
                {copied ? <Check size={18} /> : <Copy size={18} />}
              </button>
            </div>
          )}
        </div>
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
          ⚠️ You can only request a password reset once per day
        </div>
      </div>
    </div>
  );
}
