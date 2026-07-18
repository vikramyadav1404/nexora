import { useState, useEffect } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { Globe, Shield, Bell, Key, Smartphone, Mail, Check, AlertTriangle, RefreshCw, Eye, EyeOff, UserCheck, Users } from 'lucide-react';
import { LANGUAGE_META } from '../i18n/translations';

export default function Settings() {
  const { user, refreshUser, updateUser } = useAuth();
  const [tab, setTab] = useState('language');

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
        <h1 style={{ fontSize: 28, fontFamily: 'var(--font-heading)', marginBottom: 24 }}>⚙️ Settings</h1>

        {/* Tab bar */}
        <div className="tab-bar" style={{ marginBottom: 28 }}>
          {[
            { key: 'language', label: '🌍 Language' },
            { key: 'password', label: '🔒 Password' },
            { key: 'friends', label: `👥 Friends ${friendRequests.length > 0 ? `(${friendRequests.length})` : ''}` },
            { key: 'search', label: '🔍 Find People' }
          ].map(t => (
            <button key={t.key} className={`tab-item ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>

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
                    <div key={rid} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
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
                    <div key={uid} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
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
      </div>
    </div>
  );
}
