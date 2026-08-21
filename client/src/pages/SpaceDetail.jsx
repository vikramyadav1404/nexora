import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import axios from '../services/api';
import { ArrowLeft } from 'lucide-react';
import { Avatar, SkeletonList, SkeletonPostCard, ErrorState } from '../components/ui';
import useResource from '../hooks/useResource';

export default function SpaceDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState('posts');

  /*
   * The failure and the not-found cases were the same case here: `.catch(() =>
   * setData(null))` fell through to the "Space not found" screen below, so a
   * dropped connection told the user this space does not exist. They are
   * separate branches now.
   */
  const spaceRes = useResource(
    (signal) => axios.get(`/api/spaces/${id}`, { signal }).then(r => r.data),
    [id]
  );
  const { status, data } = spaceRes;

  if (status === 'loading') {
    return (
      <div className="page-container" style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <SkeletonList count={2} Item={SkeletonPostCard} />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="page-container">
        <ErrorState
          title="Could not load this Space"
          description="Check your connection and try again."
          onRetry={spaceRes.reload}
        />
      </div>
    );
  }

  // Reached only after a successful response, so this now means what it says.
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
              <Link key={m.id} to={`/profile/${m.id}`} className="side-link">
                <Avatar
                  src={m.avatarThumbUrl || m.avatar}
                  name={m.name}
                  userId={m.id}
                  size={36}
                />
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
