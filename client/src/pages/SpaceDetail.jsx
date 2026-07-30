import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import axios from '../services/api';
import { ArrowLeft } from 'lucide-react';
import { SkeletonList, SkeletonPostCard } from '../components/ui';

export default function SpaceDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('posts');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    axios.get(`/api/spaces/${id}`)
      .then(res => setData(res.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="page-container" style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <SkeletonList count={2} Item={SkeletonPostCard} />
      </div>
    );
  }

  if (!data?.space) {
    return (
      <div className="page-container">
        <div className="empty-state">
          <h3>Space not found</h3>
          <button type="button" className="btn btn-primary" onClick={() => navigate('/spaces')}>Back</button>
        </div>
      </div>
    );
  }

  const { space, posts = [], questions = [], members = [] } = data;

  return (
    <div className="page-container">
      <div style={{ maxWidth: 800, margin: '0 auto', padding: '24px 16px' }}>
        <button type="button" className="btn btn-secondary btn-sm" style={{ marginBottom: 16 }} onClick={() => navigate('/spaces')}>
          <ArrowLeft size={14} /> All spaces
        </button>

        <div className="glass-card" style={{ padding: 24, marginBottom: 16 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>{space.emoji}</div>
          <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 6 }}>{space.label}</h1>
          <p style={{ color: 'var(--text-sub)' }}>
            Community for {space.label.toLowerCase()} — share posts, ask questions, meet people.
          </p>
        </div>

        <div className="tab-bar">
          {[
            { key: 'posts', label: `Posts (${posts.length})` },
            { key: 'questions', label: `Q&A (${questions.length})` },
            { key: 'members', label: `People (${members.length})` }
          ].map(t => (
            <button key={t.key} type="button" className={`tab-item ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'posts' && (
          posts.length === 0 ? (
            <div className="empty-state"><h3>No posts yet</h3><p>Be the first to share in this space.</p></div>
          ) : posts.map(p => (
            <div key={p._id || p.id} className="post-card">
              <div style={{ fontWeight: 600, marginBottom: 8 }}>{p.author?.name}</div>
              <div className="post-content">{p.content}</div>
            </div>
          ))
        )}

        {tab === 'questions' && (
          questions.length === 0 ? (
            <div className="empty-state">
              <h3>No questions yet</h3>
              <button type="button" className="btn btn-primary" onClick={() => navigate('/ask')}>Ask one</button>
            </div>
          ) : questions.map(q => (
            <button
              key={q._id || q.id}
              type="button"
              className="question-card"
              style={{ width: '100%', textAlign: 'left' }}
              onClick={() => navigate(`/qa/${q._id || q.id}`)}
            >
              <div style={{ fontWeight: 600 }}>{q.title}</div>
            </button>
          ))
        )}

        {tab === 'members' && (
          <div className="glass-card" style={{ padding: 12 }}>
            {members.map(m => (
              <Link key={m.id} to={`/profile/${m.id}`} className="fb-side-link">
                <div className="avatar-placeholder" style={{ width: 36, height: 36 }}>{m.name?.[0]}</div>
                <div>
                  <div style={{ fontWeight: 600 }}>{m.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{m.points || 0} pts</div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
