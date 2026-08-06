import { useState, useRef, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import toast from 'react-hot-toast';
import { Eye, EyeOff, ShieldCheck, ArrowLeft } from 'lucide-react';

export default function Login() {
  const { login, verifyMfa } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', password: '' });
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Set once the password is accepted and a code is still needed. Holding the
  // pending token in state rather than storage keeps it out of anything that
  // survives the tab. Landing.jsx hands one over here when its own form hits the
  // MFA branch, so the code step exists in one place rather than two.
  const location = useLocation();
  const [pending, setPending] = useState(location.state?.mfaToken || null);
  const [code, setCode] = useState('');
  const codeRef = useRef(null);

  // Router state lives in history.state, which survives a reload. Drop it once
  // it has been read so a half-authenticated token is not left sitting there.
  useEffect(() => {
    if (location.state?.mfaToken) {
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.pathname, location.state, navigate]);

  useEffect(() => {
    if (pending) codeRef.current?.focus();
  }, [pending]);

  const goAfterLogin = (user) => {
    toast.success('Logged in');
    navigate(user?.onboardingCompleted ? '/feed' : '/onboarding');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await login(form.email, form.password);
      if (result.mfaRequired) {
        setPending(result.mfaToken);
        return;
      }
      goAfterLogin(result.user);
    } catch (err) {
      setError(err.response?.data?.message || 'The email or password you entered is incorrect.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { user, usedBackupCode, backupCodesRemaining } = await verifyMfa(pending, code);
      goAfterLogin(user);
      // Worth interrupting for: running out entirely means a lost phone locks
      // the account with nothing left to recover it.
      if (usedBackupCode && backupCodesRemaining <= 2) {
        toast(
          `${backupCodesRemaining} backup code${backupCodesRemaining === 1 ? '' : 's'} left. ` +
          'Generate more in Settings.',
          { icon: '⚠️', duration: 6000 }
        );
      }
    } catch (err) {
      setError(err.response?.data?.message || 'That code is not valid.');
      setCode('');
      codeRef.current?.focus();
    } finally {
      setLoading(false);
    }
  };

  const backToPassword = () => {
    setPending(null);
    setCode('');
    setError('');
    setForm({ ...form, password: '' });
  };

  return (
    <div className="auth-shell">
      <div className="auth-shell-main">
        <div className="auth-shell-copy">
          <div className="auth-shell-logo">nexora</div>
          <p className="auth-shell-tagline">
            {pending ? (
              <>
                One more step.<br />
                <span className="auth-shell-accent">Check your authenticator app.</span>
              </>
            ) : (
              <>
                Welcome back.<br />
                <span className="auth-shell-accent">Your Spaces are waiting.</span>
              </>
            )}
          </p>
        </div>

        <div>
          <div className="auth-shell-card animate-slideUp">
            {error && <div className="alert alert-error">{error}</div>}

            {pending ? (
              <>
                <div style={{ textAlign: 'center', marginBottom: 20 }}>
                  <ShieldCheck size={32} style={{ color: 'var(--nx-violet)' }} />
                  <h2 style={{ fontSize: 20, fontWeight: 700, margin: '10px 0 4px' }}>
                    Two-factor verification
                  </h2>
                  <p style={{ fontSize: 14, color: 'var(--text-faint)', lineHeight: 1.5 }}>
                    Enter the 6-digit code from your authenticator app, or one of your backup codes.
                  </p>
                </div>

                <form onSubmit={handleVerify}>
                  <div className="form-group">
                    <input
                      id="login-mfa-code"
                      ref={codeRef}
                      type="text"
                      className="form-input"
                      placeholder="123456"
                      value={code}
                      onChange={e => setCode(e.target.value)}
                      required
                      maxLength={11}
                      // Lets iOS and Android offer the code straight from the
                      // notification instead of making people switch apps.
                      autoComplete="one-time-code"
                      // Not inputMode="numeric": a backup code has letters, and
                      // a number-only keypad makes it impossible to type.
                      autoCapitalize="characters"
                      spellCheck={false}
                      style={{
                        textAlign: 'center',
                        fontSize: 24,
                        letterSpacing: '0.25em',
                        fontVariantNumeric: 'tabular-nums'
                      }}
                    />
                  </div>

                  <button
                    id="login-mfa-submit"
                    type="submit"
                    className="btn btn-primary"
                    style={{ width: '100%', height: 48, fontSize: 20, fontWeight: 700 }}
                    disabled={loading || code.trim().length < 6}
                  >
                    {loading ? <div className="spinner" /> : 'Verify'}
                  </button>
                </form>

                <div style={{ textAlign: 'center', marginTop: 16 }}>
                  <button
                    type="button"
                    onClick={backToPassword}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer', padding: 8,
                      color: 'var(--text-faint)', fontSize: 14, display: 'inline-flex',
                      alignItems: 'center', gap: 6
                    }}
                  >
                    <ArrowLeft size={15} /> Back to sign in
                  </button>
                </div>
              </>
            ) : (
              <>
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
                    background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)',
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
            )}
          </div>
        </div>
      </div>

      <footer className="auth-shell-footer">
        © {new Date().getFullYear()} Nexora
      </footer>
    </div>
  );
}
