import { useState, useEffect } from 'react';
import axios from '../services/api';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { Globe, Shield, Key, Smartphone, Mail, Check, AlertTriangle, RefreshCw, Eye, EyeOff, UserCheck, Users, Sparkles } from 'lucide-react';
import { LANGUAGE_META } from '../i18n/translations';

export default function Settings() {
  const { user, refreshUser, updateUser, logout } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState('language');
  const [emailOtp, setEmailOtp] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [deletePw, setDeletePw] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Language state
  const [selectedLang, setSelectedLang] = useState(user?.language || 'en');
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState('');
  const [otpMethod, setOtpMethod] = useState('');
  const [sendingOtp, setSendingOtp] = useState(false);
  const [verifyingOtp, setVerifyingOtp] = useState(false);
  const [devOtp, setDevOtp] = useState('');

  // Password change state
  const [pwForm, setPwForm] = useState({ current: '', newPw: '', confirm: '' });
  const [showPw, setShowPw] = useState(false);
  const [changingPw, setChangingPw] = useState(false);

  // Friend requests state
  const [friendRequests, setFriendRequests] = useState([]);
  const [loadingReqs, setLoadingReqs] = useState(true);

  // User search state
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    fetchFriendRequests();
  }, []);

  const fetchFriendRequests = async () => {
    try {
      const res = await axios.get('/api/users/me/requests');
      setFriendRequests(res.data.requests);
    } catch {} finally { setLoadingReqs(false); }
  };

  const handleRequestLanguage = async () => {
    if (selectedLang === user?.language) { toast('Already using this language'); return; }
    setSendingOtp(true);
    try {
      const res = await axios.post('/api/users/language', { language: selectedLang });
      setOtpSent(true);
      setOtpMethod(res.data.method);
      if (res.data.devOTP) setDevOtp(res.data.devOTP);
      toast.success(res.data.message);
    } catch (err) { toast.error(err.response?.data?.message || 'Failed'); }
    finally { setSendingOtp(false); }
  };

  const handleVerifyOTP = async () => {
    if (otp.length !== 6) { toast.error('Enter 6-digit OTP'); return; }
    setVerifyingOtp(true);
    try {
      const res = await axios.post('/api/users/verify-language-otp', { otp });
      updateUser({ language: res.data.language });
      toast.success(`Language changed to ${LANGUAGE_META[res.data.language]?.name}! 🌍`);
      setOtpSent(false);
      setOtp('');
      setDevOtp('');
      refreshUser();
    } catch (err) { toast.error(err.response?.data?.message || 'Invalid OTP'); }
    finally { setVerifyingOtp(false); }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (pwForm.newPw !== pwForm.confirm) { toast.error('Passwords do not match'); return; }
    if (pwForm.newPw.length < 6) { toast.error('Password must be at least 6 characters'); return; }
    setChangingPw(true);
    try {
      await axios.post('/api/auth/change-password', { currentPassword: pwForm.current, newPassword: pwForm.newPw });
      toast.success('Password changed successfully! 🔒');
      setPwForm({ current: '', newPw: '', confirm: '' });
    } catch (err) { toast.error(err.response?.data?.message || 'Failed'); }
    finally { setChangingPw(false); }
  };

  const handleAccept = async (fromId) => {
    try {
      await axios.post(`/api/users/accept-friend/${fromId}`);
      setFriendRequests(prev => prev.filter(r => (r._id || r) !== fromId));
      toast.success('Friend request accepted! 🎉');
      refreshUser();
    } catch { toast.error('Failed'); }
  };

  const handleDecline = async (fromId) => {
    try {
      await axios.post(`/api/users/decline-friend/${fromId}`);
      setFriendRequests(prev => prev.filter(r => (r._id || r) !== fromId));
      toast.success('Request declined');
    } catch { toast.error('Failed'); }
  };

  const handleSearch = async () => {
    if (!searchQ.trim()) return;
    setSearching(true);
    try {
      const res = await axios.get('/api/users/search', { params: { q: searchQ } });
      setSearchResults(res.data.users);
    } catch { toast.error('Search failed'); }
    finally { setSearching(false); }
  };

  const handleSendRequest = async (uid) => {
    try {
      await axios.post(`/api/users/friend-request/${uid}`);
      toast.success('Friend request sent!');
      setSearchResults(prev => prev.filter(u => u._id !== uid));
    } catch (err) { toast.error(err.response?.data?.message || 'Failed'); }
  };

  return (
    <div className="page-container">
      <div style={{ maxWidth: 700, margin: '0 auto', padding: '32px 24px' }}>
        <h1 style={{ fontSize: 24, marginBottom: 20, fontWeight: 700 }}>Settings</h1>

        {/* Tab bar */}
        <div className="tab-bar" style={{ marginBottom: 28 }}>
          {[
            { key: 'appearance', label: '🎨 Theme' },
            { key: 'language', label: '🌍 Language' },
            { key: 'interests', label: '✨ Interests' },
            { key: 'password', label: '🔒 Password' },
            { key: 'account', label: '🛡️ Account' },
            { key: 'friends', label: `👥 Friends ${friendRequests.length > 0 ? `(${friendRequests.length})` : ''}` },
            { key: 'search', label: '🔍 Find People' },
            { key: 'about', label: 'ℹ️ About' }
          ].map(t => (
            <button key={t.key} className={`tab-item ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>

        {/* APPEARANCE / DARK MODE */}
        {tab === 'appearance' && (
          <div className="glass-card" style={{ padding: 28 }}>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Appearance</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 16 }}>
              Switch between light and dark theme. Preference is saved on this device.
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              {['light', 'dark'].map(theme => (
                <button
                  key={theme}
                  type="button"
                  className={`btn ${ (localStorage.getItem('nexora_theme') || 'light') === theme ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => {
                    localStorage.setItem('nexora_theme', theme);
                    document.documentElement.setAttribute('data-theme', theme);
                    toast.success(`${theme === 'dark' ? 'Dark' : 'Light'} mode on`);
                    setTab('appearance');
                  }}
                >
                  {theme === 'dark' ? '🌙 Dark' : '☀️ Light'}
                </button>
              ))}
            </div>
            <div style={{ marginTop: 20, fontSize: 13, color: 'var(--text-faint)' }}>
              Streak: <strong>{user?.streakCount ?? '—'}</strong>
              {user?.onboardingCompleted && (
                <span> · Open <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/challenges')}>Challenges</button></span>
              )}
            </div>
          </div>
        )}

        {/* INTERESTS TAB */}
        {tab === 'interests' && (
          <div className="glass-card" style={{ padding: 28 }}>
            <h2 style={{ fontSize: 18, marginBottom: 6 }}>
              <Sparkles size={18} style={{ display: 'inline', marginRight: 8, color: 'var(--nx-violet)' }} />
              Interests &amp; feed
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 16 }}>
              Your home feed prioritizes these topics and related accounts you follow.
            </p>
            {user?.gender && (
              <p style={{ fontSize: 14, marginBottom: 10 }}>
                <strong>Gender:</strong>{' '}
                <span style={{ textTransform: 'capitalize' }}>{String(user.gender).replace(/-/g, ' ')}</span>
              </p>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 18 }}>
              {(user?.interests || []).length === 0 ? (
                <span style={{ color: 'var(--text-faint)', fontSize: 14 }}>No interests yet</span>
              ) : (
                user.interests.map(i => (
                  <span key={i} className="tag" style={{ textTransform: 'capitalize' }}>{i}</span>
                ))
              )}
            </div>
            <button type="button" className="btn btn-primary" onClick={() => navigate('/onboarding')}>
              Edit interests
            </button>
          </div>
        )}

        {/* LANGUAGE TAB */}
        {tab === 'language' && (
          <div className="glass-card" style={{ padding: 28 }}>
            <h2 style={{ fontSize: 18, marginBottom: 6 }}>
              <Globe size={18} style={{ display: 'inline', marginRight: 8 }} />
              Language Preferences
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 24 }}>
              Choose your preferred language. French requires email verification, all others require mobile OTP.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 24 }}>
              {Object.entries(LANGUAGE_META).map(([code, meta]) => (
                <div key={code} className={`lang-option ${selectedLang === code ? 'selected' : ''}`}
                  onClick={() => !otpSent && setSelectedLang(code)}>
                  <span className="lang-flag">{meta.flag}</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{meta.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{meta.nativeName}</div>
                  </div>
                  {user?.language === code && (
                    <Check size={16} style={{ color: 'var(--success)', marginLeft: 'auto' }} />
                  )}
                </div>
              ))}
            </div>

            {!otpSent ? (
              <>
                {selectedLang === 'fr' && (
                  <div className="alert alert-info" style={{ marginBottom: 16 }}>
                    <Mail size={16} /> Switching to French requires <strong>email OTP</strong> verification
                  </div>
                )}
                {selectedLang !== 'en' && selectedLang !== 'fr' && selectedLang !== user?.language && (
                  <div className="alert alert-info" style={{ marginBottom: 16 }}>
                    <Smartphone size={16} /> Switching language requires <strong>mobile OTP</strong> verification
                  </div>
                )}
                <button className="btn btn-primary" onClick={handleRequestLanguage}
                  disabled={sendingOtp || selectedLang === user?.language}>
                  {sendingOtp ? <><div className="spinner" /> Sending OTP...</> : <><Globe size={15} /> Change Language</>}
                </button>
              </>
            ) : (
              <div style={{ marginTop: 8 }}>
                <div className="alert alert-success" style={{ marginBottom: 16 }}>
                  {otpMethod === 'email' ? <Mail size={16} /> : <Smartphone size={16} />}
                  OTP sent via {otpMethod === 'email' ? 'email' : 'SMS'}
                </div>
                {devOtp && (
                  <div className="alert alert-warning" style={{ marginBottom: 16 }}>
                    <AlertTriangle size={16} />
                    <div>Dev mode OTP: <strong style={{ fontSize: 18, letterSpacing: 4 }}>{devOtp}</strong></div>
                  </div>
                )}
                <label className="form-label">Enter 6-digit OTP</label>
                <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
                  <input className="form-input" placeholder="123456" value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} maxLength={6} style={{ flex: 1, letterSpacing: 8, fontSize: 20, textAlign: 'center' }} />
                  <button className="btn btn-primary" onClick={handleVerifyOTP} disabled={verifyingOtp || otp.length !== 6}>
                    {verifyingOtp ? <div className="spinner" /> : <Check size={15} />}
                    Verify
                  </button>
                </div>
                <button style={{ background: 'none', border: 'none', color: 'var(--primary-light)', cursor: 'pointer', fontSize: 13, marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}
                  onClick={() => { setOtpSent(false); setOtp(''); setDevOtp(''); }}>
                  <RefreshCw size={13} /> Resend OTP
                </button>
              </div>
            )}
          </div>
        )}

        {/* PASSWORD TAB */}
        {tab === 'password' && (
          <div className="glass-card" style={{ padding: 28 }}>
            <h2 style={{ fontSize: 18, marginBottom: 6 }}>
              <Shield size={18} style={{ display: 'inline', marginRight: 8 }} />
              Change Password
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 24 }}>
              Keep your account secure with a strong password.
            </p>
            <form onSubmit={handleChangePassword}>
              {[
                { key: 'current', label: 'Current Password', placeholder: 'Your current password' },
                { key: 'newPw', label: 'New Password', placeholder: 'Min 6 characters' },
                { key: 'confirm', label: 'Confirm New Password', placeholder: 'Repeat new password' }
              ].map(field => (
                <div key={field.key} className="form-group">
                  <label className="form-label">{field.label}</label>
                  <div style={{ position: 'relative' }}>
                    <input type={showPw ? 'text' : 'password'} className="form-input"
                      placeholder={field.placeholder} value={pwForm[field.key]}
                      onChange={e => setPwForm({ ...pwForm, [field.key]: e.target.value })}
                      style={{ paddingRight: 42 }} required />
                    <button type="button" onClick={() => setShowPw(!showPw)} style={{
                      position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)',
                      background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)'
                    }}>{showPw ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                  </div>
                </div>
              ))}
              <button type="submit" className="btn btn-primary" disabled={changingPw}>
                {changingPw ? <><div className="spinner" /> Changing...</> : <><Key size={15} /> Change Password</>}
              </button>
            </form>
          </div>
        )}

        {/* FRIEND REQUESTS TAB */}
        {tab === 'friends' && (
          <div className="glass-card" style={{ padding: 28 }}>
            <h2 style={{ fontSize: 18, marginBottom: 16 }}>
              <Users size={18} style={{ display: 'inline', marginRight: 8 }} />
              Friend Requests ({friendRequests.length})
            </h2>
            {loadingReqs ? (
              <div className="spinner" style={{ margin: '20px auto' }} />
            ) : friendRequests.length === 0 ? (
              <div className="empty-state" style={{ padding: '40px 0' }}>
                <UserCheck size={40} style={{ margin: '0 auto 12px', opacity: 0.3 }} />
                <h3>No pending requests</h3>
                <p>Friend requests will appear here</p>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                {friendRequests.map(req => {
                  const rid = req._id || req;
                  const rname = req.name || 'User';
                  return (
                    <div key={rid} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0', borderBottom: '1px solid var(--border-soft)' }}>
                      <div className="avatar-placeholder" style={{ width: 44, height: 44, fontSize: 18, flexShrink: 0 }}>
                        {rname[0]?.toUpperCase()}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 15 }}>{rname}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{req.email}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>⭐ {req.points || 0} pts</div>
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-success btn-sm" onClick={() => handleAccept(rid)}>
                          <Check size={14} /> Accept
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={() => handleDecline(rid)}>
                          Decline
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* SEARCH TAB */}
        {tab === 'search' && (
          <div className="glass-card" style={{ padding: 28 }}>
            <h2 style={{ fontSize: 18, marginBottom: 6 }}>
              🔍 Find People
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 20 }}>
              Search for users by name or email to send friend requests.
            </p>
            <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
              <input className="form-input" placeholder="Search by name or email..."
                value={searchQ} onChange={e => setSearchQ(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                style={{ flex: 1 }} />
              <button className="btn btn-primary" onClick={handleSearch} disabled={searching}>
                {searching ? <div className="spinner" /> : '🔍'} Search
              </button>
            </div>
            {searchResults.length > 0 && (
              <div style={{ display: 'grid', gap: 10 }}>
                {searchResults.map(u => {
                  const uid = u._id;
                  const isAlreadyFriend = user?.friends?.includes(uid);
                  return (
                    <div key={uid} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border-soft)' }}>
                      <div className="avatar-placeholder" style={{ width: 40, height: 40, fontSize: 16, flexShrink: 0 }}>
                        {u.name?.[0]?.toUpperCase()}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>{u.name}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{u.email}</div>
                        <div style={{ fontSize: 12, color: 'var(--accent)' }}>⭐ {u.points || 0} pts</div>
                      </div>
                      {isAlreadyFriend ? (
                        <span className="badge badge-contributor">Friends</span>
                      ) : (
                        <button className="btn btn-primary btn-sm" onClick={() => handleSendRequest(uid)}>
                          <UserCheck size={14} /> Add
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {searchQ && searchResults.length === 0 && !searching && (
              <div className="empty-state" style={{ padding: '40px 0' }}>
                <p>No users found for "{searchQ}"</p>
              </div>
            )}
          </div>
        )}

        {/* ACCOUNT: email verify + delete */}
        {tab === 'account' && (
          <div className="glass-card" style={{ padding: 28 }}>
            <h2 style={{ fontSize: 18, marginBottom: 8 }}>
              <Shield size={18} style={{ display: 'inline', marginRight: 8 }} />
              Account security
            </h2>
            <p style={{ fontSize: 14, marginBottom: 16, color: 'var(--text-sub)' }}>
              Email: <strong>{user?.email}</strong>{' '}
              {user?.emailVerified ? (
                <span style={{ color: 'var(--success)', fontWeight: 600 }}>· Verified</span>
              ) : (
                <span style={{ color: 'var(--danger)', fontWeight: 600 }}>· Not verified</span>
              )}
            </p>

            {!user?.emailVerified && (
              <div style={{ marginBottom: 28, padding: 16, background: 'var(--bg-raised)', borderRadius: 'var(--r-md)' }}>
                <p style={{ fontSize: 14, marginBottom: 12 }}>Verify your email with a 6-digit code.</p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={emailBusy}
                    onClick={async () => {
                      setEmailBusy(true);
                      try {
                        const res = await axios.post('/api/auth/send-email-otp');
                        toast.success(res.data.message);
                        if (res.data.devEmailOtp) toast.success(`Dev OTP: ${res.data.devEmailOtp}`, { duration: 8000 });
                      } catch (err) {
                        toast.error(err.response?.data?.message || 'Failed to send code');
                      } finally {
                        setEmailBusy(false);
                      }
                    }}
                  >
                    <Mail size={14} /> Send code
                  </button>
                  <input
                    className="form-input"
                    placeholder="123456"
                    value={emailOtp}
                    onChange={e => setEmailOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    maxLength={6}
                    style={{ width: 120, letterSpacing: 4, textAlign: 'center' }}
                  />
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={emailBusy || emailOtp.length !== 6}
                    onClick={async () => {
                      setEmailBusy(true);
                      try {
                        const res = await axios.post('/api/auth/verify-email', { otp: emailOtp });
                        updateUser({ emailVerified: true });
                        toast.success(res.data.message);
                        setEmailOtp('');
                        refreshUser();
                      } catch (err) {
                        toast.error(err.response?.data?.message || 'Invalid code');
                      } finally {
                        setEmailBusy(false);
                      }
                    }}
                  >
                    Verify
                  </button>
                </div>
              </div>
            )}

            {user?.role === 'admin' && (
              <button type="button" className="btn btn-primary" style={{ marginBottom: 24 }} onClick={() => navigate('/admin')}>
                Open Admin dashboard
              </button>
            )}

            <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 20 }}>
              <h3 style={{ fontSize: 16, color: 'var(--danger)', marginBottom: 8 }}>
                <AlertTriangle size={16} style={{ display: 'inline', marginRight: 6 }} />
                Delete account
              </h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
                Permanently deletes your account and related data. This cannot be undone.
              </p>
              <input
                type="password"
                className="form-input"
                placeholder="Confirm with your password"
                value={deletePw}
                onChange={e => setDeletePw(e.target.value)}
                style={{ marginBottom: 10 }}
              />
              <button
                type="button"
                className="btn btn-secondary"
                style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
                disabled={deleteBusy || !deletePw}
                onClick={async () => {
                  if (!window.confirm('Delete your account forever?')) return;
                  setDeleteBusy(true);
                  try {
                    await axios.delete('/api/auth/account', {
                      data: { password: deletePw, confirm: 'DELETE' }
                    });
                    toast.success('Account deleted');
                    logout();
                    navigate('/');
                  } catch (err) {
                    toast.error(err.response?.data?.message || 'Delete failed');
                  } finally {
                    setDeleteBusy(false);
                  }
                }}
              >
                {deleteBusy ? 'Deleting…' : 'Delete my account'}
              </button>
            </div>
          </div>
        )}

        {/* ABOUT / VERSION */}
        {tab === 'about' && (
          <div className="glass-card" style={{ padding: 28 }}>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>About Nexora</h2>
            <p style={{ color: 'var(--text-sub)', fontSize: 14, lineHeight: 1.6, marginBottom: 16 }}>
              Interest-based community where helpful answers earn reputation — not just likes.
            </p>
            <div style={{ fontSize: 14, lineHeight: 1.8 }}>
              <div><strong>App version:</strong> 1.0.0</div>
              <div><strong>Stack:</strong> React · Express · Supabase Postgres</div>
              <div style={{ marginTop: 12, color: 'var(--text-faint)', fontSize: 13 }}>
                Settings · Theme · Interests · Safety · Challenges · Spaces · Account
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={async () => {
                  try {
                    const res = await axios.get('/api/health');
                    toast.success(
                      res.data.db === 'supabase'
                        ? `Backend: Supabase · real · v${res.data.version || '1.0.0'}`
                        : `Backend: Demo · v${res.data.version || '1.0.0'}`
                    );
                  } catch {
                    toast.error('API not reachable');
                  }
                }}
              >
                Check backend status
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/terms')}>Terms</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/privacy')}>Privacy</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
