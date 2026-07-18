import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from '../services/api';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import { Award, Users, UserPlus, UserMinus, ArrowRight, Gift, Edit2, Save, X, Camera } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

export default function Profile() {
  const { id } = useParams();
  const { user: currentUser, refreshUser, updateUser } = useAuth();
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const splitName = (full = '') => {
    const parts = String(full).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { firstName: '', middleName: '', lastName: '' };
    if (parts.length === 1) return { firstName: parts[0], middleName: '', lastName: '' };
    if (parts.length === 2) return { firstName: parts[0], middleName: '', lastName: parts[1] };
    return {
      firstName: parts[0],
      middleName: parts.slice(1, -1).join(' '),
      lastName: parts[parts.length - 1]
    };
  };

  const [editForm, setEditForm] = useState({ firstName: '', middleName: '', lastName: '', bio: '', phone: '' });
  const [saving, setSaving] = useState(false);
  const [transferModal, setTransferModal] = useState(false);
  const [transferPoints, setTransferPoints] = useState(1);
  const [transferMsg, setTransferMsg] = useState('');
  const [transferring, setTransferring] = useState(false);
  const [isFriend, setIsFriend] = useState(false);
  const [requestSent, setRequestSent] = useState(false);
  const [tab, setTab] = useState('about');

  const isOwnProfile = id === (currentUser?._id || currentUser?.id);

  useEffect(() => {
    fetchProfile();
  }, [id]);

  const fetchProfile = async () => {
    setLoading(true);
    try {
      const res = await axios.get(`/api/users/${id}`);
      setProfile(res.data.user);
      setEditForm({
        ...splitName(res.data.user.name),
        bio: res.data.user.bio || '',
        phone: res.data.user.phone || ''
      });
      const cid = currentUser?._id || currentUser?.id;
      setIsFriend(res.data.user.friends?.some(f => (f._id || f) === cid));
    } catch {
      toast.error('Profile not found');
      navigate('/feed');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveProfile = async () => {
    if (!editForm.firstName.trim() || !editForm.lastName.trim()) {
      toast.error('First name and last name are required');
      return;
    }
    setSaving(true);
    try {
      const formData = new FormData();
      formData.append('firstName', editForm.firstName.trim());
      formData.append('middleName', editForm.middleName.trim());
      formData.append('lastName', editForm.lastName.trim());
      formData.append(
        'name',
        [editForm.firstName, editForm.middleName, editForm.lastName].map(s => s.trim()).filter(Boolean).join(' ')
      );
      formData.append('bio', editForm.bio);
      formData.append('phone', editForm.phone);
      const res = await axios.put('/api/users/profile', formData);
      setProfile(res.data.user);
      updateUser({ name: res.data.user.name, bio: res.data.user.bio });
      setEditing(false);
      toast.success('Profile updated!');
    } catch { toast.error('Failed to update profile'); }
    finally { setSaving(false); }
  };

  const handleFriendRequest = async () => {
    try {
      await axios.post(`/api/users/friend-request/${id}`);
      setRequestSent(true);
      toast.success('Friend request sent!');
    } catch (err) { toast.error(err.response?.data?.message || 'Failed'); }
  };

  const handleRemoveFriend = async () => {
    if (!confirm('Remove this friend?')) return;
    try {
      await axios.delete(`/api/users/friend/${id}`);
      setIsFriend(false);
      toast.success('Friend removed');
      refreshUser();
    } catch { toast.error('Failed'); }
  };

  const handleTransferPoints = async () => {
    if (transferPoints < 1) return;
    setTransferring(true);
    try {
      const res = await axios.post('/api/rewards/transfer', {
        toUserId: id,
        points: transferPoints,
        message: transferMsg
      });
      toast.success(res.data.message);
      setTransferModal(false);
      refreshUser();
      fetchProfile();
    } catch (err) { toast.error(err.response?.data?.message || 'Transfer failed'); }
    finally { setTransferring(false); }
  };

  const BADGE_INFO = {
    bronze: { label: 'Bronze', emoji: '🥉', desc: '50+ points' },
    silver: { label: 'Silver', emoji: '🥈', desc: '200+ points' },
    gold: { label: 'Gold', emoji: '🥇', desc: '500+ points' },
    contributor: { label: 'Contributor', emoji: '✍️', desc: '10+ answers' },
    expert: { label: 'Expert', emoji: '🎓', desc: '50+ answers' }
  };

  if (loading) return (
    <div className="page-container" style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
      <div className="spinner spinner-lg" />
    </div>
  );
  if (!profile) return null;

  const initials = profile.name?.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

  return (
    <div className="page-container">
      <div style={{ maxWidth: 800, margin: '0 auto', padding: '32px 24px' }}>

        {/* Profile Hero */}
        <div className="profile-hero">
          <div style={{ position: 'relative' }}>
            {profile.avatar
              ? <img src={profile.avatar} className="profile-avatar-large" alt={profile.name} />
              : <div className="profile-avatar-placeholder">{initials}</div>
            }
            {isOwnProfile && editing && (
              <label style={{ position: 'absolute', bottom: 8, right: 8, width: 36, height: 36, borderRadius: '50%', background: '#E4E6EB', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', border: '2px solid #fff' }}>
                <Camera size={16} color="#050505" />
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={async (e) => {
                  const fd = new FormData();
                  fd.append('avatar', e.target.files[0]);
                  const res = await axios.put('/api/users/profile', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
                  setProfile(res.data.user);
                  updateUser({ avatar: res.data.user.avatar });
                  toast.success('Avatar updated!');
                }} />
              </label>
            )}
          </div>

          <div style={{ flex: 1 }}>
            {editing ? (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                  <input
                    className="form-input"
                    placeholder="First name"
                    value={editForm.firstName}
                    onChange={e => setEditForm({ ...editForm, firstName: e.target.value })}
                  />
                  <input
                    className="form-input"
                    placeholder="Last name"
                    value={editForm.lastName}
                    onChange={e => setEditForm({ ...editForm, lastName: e.target.value })}
                  />
                </div>
                <input
                  className="form-input"
                  placeholder="Middle name (optional)"
                  value={editForm.middleName}
                  onChange={e => setEditForm({ ...editForm, middleName: e.target.value })}
                  style={{ marginBottom: 8 }}
                />
                <textarea className="form-input" placeholder="Bio..." value={editForm.bio} onChange={e => setEditForm({ ...editForm, bio: e.target.value })} rows={2} style={{ marginBottom: 8 }} />
                <input className="form-input" placeholder="Phone..." value={editForm.phone} onChange={e => setEditForm({ ...editForm, phone: e.target.value })} style={{ marginBottom: 12 }} />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-primary btn-sm" onClick={handleSaveProfile} disabled={saving}>
                    <Save size={14} /> {saving ? 'Saving...' : 'Save'}
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setEditing(false)}>
                    <X size={14} /> Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
                  <h1 style={{ fontSize: 24, fontWeight: 800 }}>{profile.name}</h1>
                  <span className={`badge badge-plan-${profile.subscription?.plan || 'free'}`}>
                    {(profile.subscription?.plan || 'free').toUpperCase()}
                  </span>
                  {profile.badges?.map(b => <span key={b} className={`badge badge-${b}`}>{BADGE_INFO[b]?.emoji} {BADGE_INFO[b]?.label}</span>)}
                </div>
                {profile.bio && <p style={{ color: 'var(--text-secondary)', marginBottom: 10, fontSize: 15 }}>{profile.bio}</p>}
                <div style={{ display: 'flex', gap: 20, fontSize: 14, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                  <span>📧 {profile.email}</span>
                  {profile.phone && <span>📱 {profile.phone}</span>}
                  <span>📅 Joined {formatDistanceToNow(new Date(profile.createdAt), { addSuffix: true })}</span>
                </div>
              </>
            )}
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {isOwnProfile ? (
              !editing && <button className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
                <Edit2 size={14} /> Edit Profile
              </button>
            ) : (
              <>
                {isFriend ? (
                  <button className="btn btn-danger btn-sm" onClick={handleRemoveFriend}>
                    <UserMinus size={14} /> Remove Friend
                  </button>
                ) : (
                  <button className="btn btn-primary btn-sm" onClick={handleFriendRequest} disabled={requestSent}>
                    <UserPlus size={14} /> {requestSent ? 'Request Sent' : 'Add Friend'}
                  </button>
                )}
                {isFriend && (
                  <button className="btn btn-secondary btn-sm" onClick={() => setTransferModal(true)}>
                    <Gift size={14} /> Transfer Points
                  </button>
                )}
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={async () => {
                    try {
                      await axios.post(`/api/users/follow/${id}`);
                      toast.success('Following');
                    } catch (err) {
                      toast.error(err.response?.data?.message || 'Could not follow');
                    }
                  }}
                >
                  Follow
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={async () => {
                    const reason = prompt('Why are you reporting this user?') || '';
                    if (!reason.trim()) return;
                    try {
                      await axios.post('/api/reports', {
                        targetType: 'user',
                        targetId: id,
                        reason
                      });
                      toast.success('Report submitted');
                    } catch (err) {
                      toast.error(err.response?.data?.message || 'Report failed');
                    }
                  }}
                >
                  Report
                </button>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={async () => {
                    if (!confirm('Block this user?')) return;
                    try {
                      await axios.post(`/api/blocks/${id}`);
                      toast.success('User blocked');
                      navigate('/feed');
                    } catch (err) {
                      toast.error(err.response?.data?.message || 'Block failed');
                    }
                  }}
                >
                  Block
                </button>
              </>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="stats-grid" style={{ marginBottom: 24 }}>
          {[
            { value: profile.points || 0, label: 'Points', color: 'var(--accent)', icon: '⭐' },
            { value: profile.friends?.length || 0, label: 'Friends', color: 'var(--secondary)', icon: '👥' },
            { value: profile.totalAnswers || 0, label: 'Answers', color: 'var(--success)', icon: '✍️' },
            { value: profile.totalUpvotesReceived || 0, label: 'Upvotes', color: 'var(--primary-light)', icon: '👍' }
          ].map(s => (
            <div key={s.label} className="stat-card">
              <div style={{ fontSize: 22, marginBottom: 4 }}>{s.icon}</div>
              <div className="value" style={{ color: s.color }}>{s.value}</div>
              <div className="label">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="tab-bar">
          {['about', 'badges', 'friends'].map(t => (
            <button key={t} className={`tab-item ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {tab === 'about' && (
          <div className="glass-card" style={{ padding: 24 }}>
            <h3 style={{ marginBottom: 16 }}>About</h3>
            <div style={{ display: 'grid', gap: 12 }}>
              {[
                { label: 'Subscription Plan', value: <span className={`badge badge-plan-${profile.subscription?.plan || 'free'}`}>{(profile.subscription?.plan || 'free').toUpperCase()}</span> },
                { label: 'Points', value: <span style={{ color: 'var(--accent)', fontWeight: 700 }}>⭐ {profile.points || 0}</span> },
                { label: 'Language', value: profile.language?.toUpperCase() || 'EN' },
                { label: 'Total Answers', value: profile.totalAnswers || 0 },
                { label: 'Total Friends', value: profile.friends?.length || 0 }
              ].map(item => (
                <div key={item.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>{item.label}</span>
                  <span style={{ fontWeight: 500 }}>{item.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'badges' && (
          <div className="glass-card" style={{ padding: 24 }}>
            <h3 style={{ marginBottom: 16 }}>Badges & Achievements</h3>
            {profile.badges?.length === 0 ? (
              <div className="empty-state" style={{ padding: '40px 0' }}>
                <Award size={40} style={{ margin: '0 auto 12px', opacity: 0.3 }} />
                <h3>No badges yet</h3>
                <p>Earn points and contribute answers to unlock badges!</p>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 16 }}>
                {profile.badges?.map(b => (
                  <div key={b} style={{ textAlign: 'center', padding: 20, background: 'rgba(255,255,255,0.03)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(255,255,255,0.07)' }}>
                    <div style={{ fontSize: 36, marginBottom: 8 }}>{BADGE_INFO[b]?.emoji}</div>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>{BADGE_INFO[b]?.label}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{BADGE_INFO[b]?.desc}</div>
                  </div>
                ))}
              </div>
            )}
            {/* Badge progress */}
            <div style={{ marginTop: 24 }}>
              <h4 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 12 }}>Points Progress</h4>
              {[
                { badge: 'Bronze', points: 50, icon: '🥉' },
                { badge: 'Silver', points: 200, icon: '🥈' },
                { badge: 'Gold', points: 500, icon: '🥇' }
              ].map(({ badge, points, icon }) => {
                const pct = Math.min(100, Math.round(((profile.points || 0) / points) * 100));
                return (
                  <div key={badge} style={{ marginBottom: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                      <span>{icon} {badge} ({points} pts)</span>
                      <span style={{ color: 'var(--text-muted)' }}>{Math.min(profile.points || 0, points)}/{points}</span>
                    </div>
                    <div style={{ height: 8, background: 'rgba(255,255,255,0.07)', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: badge === 'Gold' ? 'var(--gradient-gold)' : 'var(--gradient-primary)', borderRadius: 4, transition: 'width 0.5s ease' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {tab === 'friends' && (
          <div className="glass-card" style={{ padding: 24 }}>
            <h3 style={{ marginBottom: 16 }}>Friends ({profile.friends?.length || 0})</h3>
            {profile.friends?.length === 0 ? (
              <div className="empty-state" style={{ padding: '40px 0' }}>
                <Users size={40} style={{ margin: '0 auto 12px', opacity: 0.3 }} />
                <h3>No friends yet</h3>
                <p>Connect with others to grow your network!</p>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                {profile.friends?.map(friend => {
                  const fid = friend._id || friend;
                  const fname = friend.name || 'User';
                  return (
                    <div key={fid} className="leaderboard-item" style={{ cursor: 'pointer' }}
                      onClick={() => navigate(`/profile/${fid}`)}>
                      <div className="avatar-placeholder" style={{ width: 40, height: 40, flexShrink: 0, fontSize: 16 }}>
                        {fname[0]?.toUpperCase()}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 15 }}>{fname}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>⭐ {friend.points || 0} points</div>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {friend.badges?.slice(0, 2).map(b => <span key={b} className={`badge badge-${b}`}>{BADGE_INFO[b]?.emoji}</span>)}
                      </div>
                      <ArrowRight size={16} color="var(--text-muted)" />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Transfer Points Modal */}
        {transferModal && (
          <div className="modal-overlay" onClick={() => setTransferModal(false)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3 className="modal-title">🎁 Transfer Points to {profile.name}</h3>
                <button className="modal-close" onClick={() => setTransferModal(false)}><X size={16} /></button>
              </div>
              <div className="alert alert-warning" style={{ marginBottom: 16 }}>
                You need <strong>more than 10 points</strong> to transfer. Your balance: <strong>⭐ {currentUser?.points || 0}</strong>
              </div>
              <div className="form-group">
                <label className="form-label">Points to Transfer</label>
                <input type="number" className="form-input" value={transferPoints} min={1}
                  max={Math.max(0, (currentUser?.points || 0) - 10)}
                  onChange={e => setTransferPoints(Number(e.target.value))} />
                <small style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                  Max transferable: {Math.max(0, (currentUser?.points || 0) - 10)} points
                </small>
              </div>
              <div className="form-group">
                <label className="form-label">Message (optional)</label>
                <input type="text" className="form-input" placeholder="Great answer! Keep it up..." value={transferMsg} onChange={e => setTransferMsg(e.target.value)} />
              </div>
              <button className="btn btn-primary" style={{ width: '100%' }} onClick={handleTransferPoints} disabled={transferring || (currentUser?.points || 0) <= 10}>
                {transferring ? <><div className="spinner" /> Transferring...</> : <><Gift size={15} /> Transfer {transferPoints} Points</>}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
