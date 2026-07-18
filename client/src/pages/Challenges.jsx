import { useState, useEffect } from 'react';
import axios from '../services/api';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import { Flame, Trophy, Target } from 'lucide-react';

export default function Challenges() {
  const { refreshUser } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const res = await axios.get('/api/challenges');
      setData(res.data);
    } catch {
      toast.error('Failed to load challenges');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const checkIn = async () => {
    try {
      const res = await axios.post('/api/challenges/check-in');
      toast.success(res.data.message + ` · ${res.data.streakCount} day streak`);
      await refreshUser();
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Check-in failed');
    }
  };

  if (loading) {
    return (
      <div className="page-container" style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <div className="spinner spinner-lg" />
      </div>
    );
  }

  const streak = data?.streak?.count || 0;
  const challenges = data?.challenges || [];

  return (
    <div className="page-container">
      <div style={{ maxWidth: 700, margin: '0 auto', padding: '24px 16px' }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Target size={22} color="var(--fb-blue)" /> Challenges
        </h1>
        <p style={{ color: 'var(--text-sub)', marginBottom: 20 }}>
          Build habits. Earn bonus points. Climb the leaderboard.
        </p>

        <div className="glass-card" style={{ padding: 20, marginBottom: 20, textAlign: 'center' }}>
          <Flame size={32} color="#F02849" style={{ marginBottom: 8 }} />
          <div style={{ fontSize: 36, fontWeight: 800 }}>{streak}</div>
          <div style={{ color: 'var(--text-sub)', marginBottom: 12 }}>day streak</div>
          <button type="button" className="btn btn-primary" onClick={checkIn}>
            Daily check-in
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {challenges.map(c => (
            <div key={c.id} className="glass-card" style={{ padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{c.title}</div>
                  <div style={{ fontSize: 13, color: 'var(--text-sub)' }}>{c.desc}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <Trophy size={16} color="#F7B928" />
                  <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>+{c.reward} pts</div>
                </div>
              </div>
              <div style={{
                height: 8, background: 'var(--bg-raised)', borderRadius: 99, overflow: 'hidden', marginBottom: 6
              }}>
                <div style={{
                  height: '100%', width: `${c.percent}%`,
                  background: c.completed ? 'var(--green)' : 'var(--fb-blue)',
                  borderRadius: 99
                }} />
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                {c.current}/{c.goal} {c.completed ? '· Completed ✓' : ''}
              </div>
            </div>
          ))}
        </div>

        <div className="glass-card" style={{ padding: 16, marginTop: 20 }}>
          <h3 style={{ fontSize: 16, marginBottom: 8 }}>Weekly digest</h3>
          <p style={{ fontSize: 13, color: 'var(--text-sub)', marginBottom: 12 }}>
            See top posts and questions from your interests this week (in-app).
          </p>
          <DigestButton />
        </div>
      </div>
    </div>
  );
}

function DigestButton() {
  const [open, setOpen] = useState(false);
  const [digest, setDigest] = useState(null);

  const load = async () => {
    const res = await axios.get('/api/digests/weekly');
    setDigest(res.data);
    setOpen(true);
  };

  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={load}>
        View weekly digest
      </button>
      {open && digest && (
        <div style={{ marginTop: 14, fontSize: 13 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>{digest.title}</div>
          <div style={{ color: 'var(--text-faint)', marginBottom: 8 }}>
            Interests: {(digest.interests || []).join(', ') || '—'} · Streak: {digest.streak}
          </div>
          <div style={{ marginBottom: 6 }}><strong>Top posts:</strong> {(digest.topPosts || []).length}</div>
          <ul style={{ paddingLeft: 18, color: 'var(--text-sub)' }}>
            {(digest.topPosts || []).slice(0, 3).map(p => (
              <li key={p._id || p.id}>{(p.content || '').slice(0, 80)}</li>
            ))}
          </ul>
          <div style={{ marginTop: 8 }}><strong>Top questions:</strong> {(digest.topQuestions || []).length}</div>
          <ul style={{ paddingLeft: 18, color: 'var(--text-sub)' }}>
            {(digest.topQuestions || []).slice(0, 3).map(q => (
              <li key={q._id || q.id}>{q.title}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
