import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Eye, EyeOff } from 'lucide-react';

/**
 * The email + password half of signing in.
 *
 * Landing and Login both show it. They used to hold their own copy — 61
 * identical lines of state, markup and submit handler — and the cost showed up
 * the moment two-factor landed: the `mfaRequired` branch had to be written into
 * both, and Landing ended up redirecting to /login precisely because nobody
 * wanted to build the code step twice.
 *
 * What happens *after* a correct password differs between the two, so that part
 * stays with the caller:
 *
 *   onSuccess(user)          password was enough, a session exists
 *   onMfaRequired(mfaToken)  password was correct, a code is still needed
 *
 * Login sets local state and swaps in its code step. Landing hands the pending
 * token to /login through router state. Neither needs to know how the other
 * behaves.
 */
export default function AuthForm({ idPrefix = 'login', onSuccess, onMfaRequired }) {
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
      const result = await login(form.email, form.password);
      if (result.mfaRequired) {
        onMfaRequired?.(result.mfaToken);
        return;
      }
      onSuccess?.(result.user);
    } catch (err) {
      // Deliberately the same message for an unknown address and a wrong
      // password — telling them apart would confirm which accounts exist.
      setError(err.response?.data?.message || 'The email or password you entered is incorrect.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {error && <div className="alert alert-error">{error}</div>}

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <input
            id={`${idPrefix}-email`}
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
            id={`${idPrefix}-password`}
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
          id={`${idPrefix}-submit`}
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
    </>
  );
}
