import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import toast from 'react-hot-toast';
import { X, Eye, EyeOff } from 'lucide-react';

const GENDERS = [
  { id: 'female', label: 'Female' },
  { id: 'male', label: 'Male' },
  { id: 'non-binary', label: 'Non-binary' },
  { id: 'prefer-not-to-say', label: 'Prefer not to say' }
];

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    firstName: '', middleName: '', lastName: '',
    email: '', phone: '', password: '', confirm: '', gender: ''
  });
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!form.firstName.trim()) { setError('Please enter your first name'); return; }
    if (!form.lastName.trim()) { setError('Please enter your last name'); return; }
    if (!form.gender) { setError('Please select your gender'); return; }
    if (form.password !== form.confirm) { setError("Passwords don't match"); return; }
    if (form.password.length < 6) { setError('Password needs at least 6 characters'); return; }
    setLoading(true);
    try {
      const user = await register({
        firstName: form.firstName.trim(),
        middleName: form.middleName.trim(),
        lastName: form.lastName.trim(),
        email: form.email,
        phone: form.phone,
        password: form.password,
        gender: form.gender
      });
      if (user?._registerMeta?.devEmailOtp) {
        toast.success(`Dev OTP: ${user._registerMeta.devEmailOtp}`, { duration: 8000 });
      } else {
        toast.success(user?._registerMeta?.message || 'Account created — check your email');
      }
      navigate(user?.onboardingCompleted ? '/feed' : '/onboarding');
    } catch (err) {
      setError(err.response?.data?.message || 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fb-landing" style={{ justifyContent: 'center' }}>
      <div style={{
        minHeight: '100vh', width: '100%', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        padding: 20, background: 'var(--bg-glass)'
      }}>
        <div className="modal animate-slideUp" style={{ maxWidth: 432, padding: 0, overflow: 'hidden' }}>
          <div style={{
            padding: '16px 16px 12px',
            borderBottom: '1px solid var(--border-soft)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between'
          }}>
            <div>
              <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 2 }}>Sign Up</h1>
              <p style={{ fontSize: 15, color: 'var(--text-sub)' }}>It&apos;s quick and easy.</p>
            </div>
            <button
              type="button"
              className="modal-close"
              onClick={() => navigate('/login')}
              aria-label="Close"
            >
              <X size={20} />
            </button>
          </div>

          <div style={{ padding: '16px' }}>
            {error && <div className="alert alert-error">{error}</div>}

            <form onSubmit={handleSubmit}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="form-group" style={{ marginBottom: 12 }}>
                  <input
                    id="register-first-name"
                    type="text"
                    className="form-input"
                    placeholder="First name"
                    value={form.firstName}
                    onChange={e => setForm({ ...form, firstName: e.target.value })}
                    required
                    autoComplete="given-name"
                    style={{ background: 'var(--bg-raised)', fontSize: 15, padding: '11px' }}
                  />
                </div>
                <div className="form-group" style={{ marginBottom: 12 }}>
                  <input
                    id="register-last-name"
                    type="text"
                    className="form-input"
                    placeholder="Last name"
                    value={form.lastName}
                    onChange={e => setForm({ ...form, lastName: e.target.value })}
                    required
                    autoComplete="family-name"
                    style={{ background: 'var(--bg-raised)', fontSize: 15, padding: '11px' }}
                  />
                </div>
              </div>

              <div className="form-group">
                <input
                  id="register-middle-name"
                  type="text"
                  className="form-input"
                  placeholder="Middle name (optional)"
                  value={form.middleName}
                  onChange={e => setForm({ ...form, middleName: e.target.value })}
                  autoComplete="additional-name"
                  style={{ background: 'var(--bg-raised)', fontSize: 15, padding: '11px' }}
                />
              </div>

              <div className="form-group">
                <input
                  id="register-email"
                  type="email"
                  className="form-input"
                  placeholder="Email address"
                  value={form.email}
                  onChange={e => setForm({ ...form, email: e.target.value })}
                  required
                  autoComplete="email"
                  style={{ background: 'var(--bg-raised)', fontSize: 15, padding: '11px' }}
                />
              </div>

              <div className="form-group">
                <input
                  id="register-phone"
                  type="tel"
                  className="form-input"
                  placeholder="Mobile number (optional)"
                  value={form.phone}
                  onChange={e => setForm({ ...form, phone: e.target.value })}
                  autoComplete="tel"
                  style={{ background: 'var(--bg-raised)', fontSize: 15, padding: '11px' }}
                />
              </div>

              {/* Gender */}
              <div className="form-group">
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-sub)', marginBottom: 8 }}>
                  Gender
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {GENDERS.map(g => (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => setForm({ ...form, gender: g.id })}
                      style={{
                        padding: '10px 8px',
                        borderRadius: 'var(--r-sm)',
                        border: form.gender === g.id
                          ? '2px solid var(--nx-violet)'
                          : '1px solid var(--border)',
                        background: form.gender === g.id
                          ? 'var(--nx-violet-soft)'
                          : 'var(--bg-raised)',
                        fontWeight: 600,
                        fontSize: 13,
                        cursor: 'pointer',
                        // Was hardcoded near-black, which left these buttons
                        // white-on-white unreadable in dark mode.
                        color: form.gender === g.id ? 'var(--nx-violet)' : 'var(--text-base)',
                        fontFamily: 'inherit'
                      }}
                    >
                      {g.label}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="form-group" style={{ marginBottom: 12, position: 'relative' }}>
                  <input
                    id="register-password"
                    type={showPw ? 'text' : 'password'}
                    className="form-input"
                    placeholder="New password"
                    value={form.password}
                    onChange={e => setForm({ ...form, password: e.target.value })}
                    required
                    autoComplete="new-password"
                    style={{ background: 'var(--bg-raised)', fontSize: 15, padding: '11px', paddingRight: 36 }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw(!showPw)}
                    style={{
                      position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                      background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)',
                      display: 'flex', padding: 0
                    }}
                  >
                    {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <div className="form-group" style={{ marginBottom: 12 }}>
                  <input
                    id="register-confirm"
                    type="password"
                    className="form-input"
                    placeholder="Confirm password"
                    value={form.confirm}
                    onChange={e => setForm({ ...form, confirm: e.target.value })}
                    required
                    autoComplete="new-password"
                    style={{ background: 'var(--bg-raised)', fontSize: 15, padding: '11px' }}
                  />
                </div>
              </div>

              <p style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.4, marginBottom: 14 }}>
                By clicking Sign Up, you agree to our{' '}
                <Link to="/terms" style={{ color: 'var(--fb-blue)' }}>Terms</Link>
                {' '}and{' '}
                <Link to="/privacy" style={{ color: 'var(--fb-blue)' }}>Privacy Policy</Link>.
                Next you&apos;ll verify email and choose interests for a personalized feed.
              </p>

              <div style={{ textAlign: 'center' }}>
                <button
                  id="register-submit"
                  type="submit"
                  className="btn-create"
                  style={{ minWidth: 194, height: 36, fontSize: 18 }}
                  disabled={loading}
                >
                  {loading ? <div className="spinner" style={{ borderTopColor: 'var(--text-on-accent)' }} /> : 'Sign Up'}
                </button>
              </div>
            </form>

            <p style={{ textAlign: 'center', marginTop: 16, fontSize: 14 }}>
              <Link to="/login" style={{ color: 'var(--fb-blue)', fontWeight: 500 }}>
                Already have an account?
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
