import { useState } from 'react';
import { Link } from 'react-router-dom';
import axios from '../services/api';
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
      // Not "reset successful" — the server answers identically whether or not
      // an account exists, so claiming success would be asserting something we
      // were deliberately not told.
      toast.success('Check your inbox');
    } catch (err) {
      setError(err.response?.data?.message || 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '40px 16px', flexDirection: 'column'
      }}>
        <div className="auth-shell-logo" style={{ fontSize: 40, marginBottom: 24 }}>nexora</div>

        <div className="auth-shell-card animate-slideUp" style={{ maxWidth: 500 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Find Your Account</h1>
          <p style={{ fontSize: 15, color: 'var(--text-sub)', marginBottom: 16, lineHeight: 1.4 }}>
            Please enter your email or mobile number to search for your account.
          </p>

          <Link
            to="/login"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontSize: 14, color: 'var(--nx-violet)', marginBottom: 16, fontWeight: 500
            }}
          >
            <ArrowLeft size={14} /> Back to login
          </Link>

          <div className="tab-bar" style={{ marginBottom: 16, boxShadow: 'none', border: '1px solid var(--border-soft)' }}>
            <button
              type="button"
              className={`tab-item ${method === 'email' ? 'active' : ''}`}
              onClick={() => setMethod('email')}
            >
              Email
            </button>
            <button
              type="button"
              className={`tab-item ${method === 'phone' ? 'active' : ''}`}
              onClick={() => setMethod('phone')}
            >
              Phone
            </button>
          </div>

          {error && <div className="alert alert-error">{error}</div>}
          {success && <div className="alert alert-success">{success}</div>}

          {newPwResult && (
            <div className="alert alert-info" style={{ flexDirection: 'column', gap: 8 }}>
              <strong>Your new password (dev mode):</strong>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: 'var(--bg-surface)', padding: '10px 12px', borderRadius: 6,
                border: '1px solid var(--border-soft)'
              }}>
                <code style={{ flex: 1, fontSize: 16, letterSpacing: 1, color: 'var(--text-base)' }}>
                  {newPwResult}
                </code>
                <button
                  type="button"
                  onClick={() => { navigator.clipboard.writeText(newPwResult); toast.success('Copied!'); }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--nx-violet)' }}
                >
                  <Copy size={16} />
                </button>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <div className="input-wrapper">
                {method === 'email'
                  ? <Mail size={16} className="input-icon" />
                  : <Phone size={16} className="input-icon" />
                }
                <input
                  type={method === 'email' ? 'email' : 'tel'}
                  className="form-input"
                  placeholder={method === 'email' ? 'Email address' : 'Mobile number'}
                  value={value}
                  onChange={e => setValue(e.target.value)}
                  required
                  style={{ fontSize: 16 }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Link to="/login" className="btn btn-secondary">Cancel</Link>
              <button type="submit" className="btn btn-primary" disabled={loading}>
                {loading ? <div className="spinner" /> : <><Key size={15} /> Search</>}
              </button>
            </div>
          </form>

          <div style={{
            marginTop: 20, padding: 14,
            background: 'var(--bg-base)',
            borderRadius: 8
          }}>
            <h4 style={{
              fontSize: 14, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8,
              fontWeight: 600
            }}>
              <RefreshCw size={15} style={{ color: 'var(--nx-violet)' }} />
              Password generator
            </h4>
            <p style={{ fontSize: 13, color: 'var(--text-sub)', marginBottom: 12 }}>
              Generate a random password with only letters (upper + lowercase).
            </p>
            <button type="button" className="btn btn-secondary" style={{ width: '100%', marginBottom: 10 }} onClick={handleGenerate}>
              <RefreshCw size={15} /> Generate password
            </button>
            {generatedPw && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                background: 'var(--bg-surface)', padding: '10px 12px',
                borderRadius: 6, border: '1px solid var(--border-soft)'
              }}>
                <code style={{ flex: 1, fontSize: 16, letterSpacing: 2 }}>{generatedPw}</code>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(generatedPw);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                    toast.success('Copied!');
                  }}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: copied ? 'var(--green)' : 'var(--text-sub)'
                  }}
                >
                  {copied ? <Check size={18} /> : <Copy size={18} />}
                </button>
              </div>
            )}
          </div>

          <p style={{ marginTop: 14, fontSize: 12, color: 'var(--text-faint)', textAlign: 'center' }}>
            You can only request a password reset once per day.
          </p>
        </div>
      </div>
    </div>
  );
}
