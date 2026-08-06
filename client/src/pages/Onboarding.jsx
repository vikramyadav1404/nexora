import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from '../services/api';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import { Sparkles, Check } from 'lucide-react';

const FALLBACK_INTERESTS = [
  { id: 'technology', label: 'Technology', emoji: '💻' },
  { id: 'sports', label: 'Sports', emoji: '⚽' },
  { id: 'music', label: 'Music', emoji: '🎵' },
  { id: 'movies', label: 'Movies & TV', emoji: '🎬' },
  { id: 'gaming', label: 'Gaming', emoji: '🎮' },
  { id: 'fashion', label: 'Fashion', emoji: '👗' },
  { id: 'food', label: 'Food', emoji: '🍕' },
  { id: 'travel', label: 'Travel', emoji: '✈️' },
  { id: 'fitness', label: 'Fitness', emoji: '💪' },
  { id: 'art', label: 'Art & Design', emoji: '🎨' },
  { id: 'business', label: 'Business', emoji: '💼' },
  { id: 'science', label: 'Science', emoji: '🔬' },
  { id: 'education', label: 'Education', emoji: '📚' },
  { id: 'photography', label: 'Photography', emoji: '📷' },
  { id: 'news', label: 'News', emoji: '📰' },
  { id: 'comedy', label: 'Comedy', emoji: '😂' }
];

export default function Onboarding() {
  const { user, refreshUser, updateUser } = useAuth();
  const navigate = useNavigate();
  const [interests, setInterests] = useState(FALLBACK_INTERESTS);
  const [selected, setSelected] = useState([]);
  const [gender, setGender] = useState(user?.gender || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (user?.interests?.length) setSelected(user.interests);
    if (user?.gender) setGender(user.gender);
  }, [user]);

  useEffect(() => {
    axios.get('/api/users/interests/catalog')
      .then(res => {
        if (res.data.interests?.length) setInterests(res.data.interests);
      })
      .catch(() => {});
  }, []);

  const toggle = (id) => {
    setSelected(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (prev.length >= 8) {
        toast.error('You can pick up to 8 interests');
        return prev;
      }
      return [...prev, id];
    });
  };

  const handleContinue = async () => {
    setError('');
    if (selected.length < 1) {
      setError('Pick at least one interest so we can personalize your feed.');
      return;
    }
    setLoading(true);
    try {
      const res = await axios.post('/api/users/onboarding', {
        interests: selected,
        gender: gender || user?.gender || undefined
      });
      updateUser(res.data.user);
      await refreshUser();
      const followed = res.data.seed?.creatorsFollowed || 0;
      toast.success(
        followed
          ? `Nice — following ${followed} interest accounts`
          : 'Saved. Your feed should feel more relevant now'
      );
      navigate('/feed', { replace: true });
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save preferences');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg-base)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 20
    }}>
      <div className="animate-slideUp" style={{
        width: '100%',
        maxWidth: 560,
        background: 'var(--bg-surface)',
        borderRadius: 12,
        boxShadow: '0 2px 12px rgba(0,0,0,0.12)',
        padding: '28px 24px 24px'
      }}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <div style={{
            width: 52, height: 52, borderRadius: '50%', margin: '0 auto 12px',
            background: 'var(--nx-violet-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            <Sparkles size={24} color="#0866FF" />
          </div>
          <h1 style={{ fontSize: 26, fontWeight: 700, marginBottom: 6 }}>
            What are you into?
          </h1>
          <p style={{ fontSize: 15, color: 'var(--text-sub)', lineHeight: 1.45 }}>
            Pick a few interests. We&apos;ll fill your home feed and follow related accounts so you can jump in right away.
          </p>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        {/* Gender if missing */}
        {(!user?.gender || user.gender === '') && (
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-sub)', marginBottom: 8 }}>
              Gender
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {[
                { id: 'female', label: 'Female' },
                { id: 'male', label: 'Male' },
                { id: 'non-binary', label: 'Non-binary' },
                { id: 'prefer-not-to-say', label: 'Prefer not to say' }
              ].map(g => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setGender(g.id)}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: gender === g.id ? '2px solid #0866FF' : '1px solid var(--border)',
                    background: gender === g.id ? 'var(--nx-violet-soft)' : 'var(--bg-raised)',
                    fontWeight: 600,
                    fontSize: 14,
                    cursor: 'pointer',
                    color: 'var(--text-base)',
                    fontFamily: 'var(--font-body)'
                  }}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-sub)', marginBottom: 10 }}>
          Interests <span style={{ fontWeight: 400 }}>({selected.length}/8)</span>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
          gap: 8,
          marginBottom: 22
        }}>
          {interests.map(item => {
            const active = selected.includes(item.id);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => toggle(item.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '12px 12px',
                  borderRadius: 10,
                  border: active ? '2px solid #0866FF' : '1px solid var(--border-soft)',
                  background: active ? 'var(--nx-violet-soft)' : 'var(--bg-raised)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: 'var(--font-body)',
                  position: 'relative'
                }}
              >
                <span style={{ fontSize: 18 }}>{item.emoji}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-base)' }}>
                  {item.label}
                </span>
                {active && (
                  <Check size={14} color="#0866FF" style={{ marginLeft: 'auto', flexShrink: 0 }} />
                )}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          className="btn btn-primary"
          style={{ width: '100%', height: 44, fontSize: 16 }}
          onClick={handleContinue}
          disabled={loading}
        >
          {loading ? <div className="spinner" /> : 'Build my feed'}
        </button>

        <p style={{
          marginTop: 14, fontSize: 12, color: 'var(--text-faint)', textAlign: 'center', lineHeight: 1.4
        }}>
          We&apos;ll auto-follow interest hubs and show related posts on your home page. You can change this later in Settings.
        </p>
      </div>
    </div>
  );
}
