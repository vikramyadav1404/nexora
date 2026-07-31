import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from '../services/api';
import { Layers } from 'lucide-react';
import { EmptyState, ErrorState, SkeletonList, SkeletonQuestionCard } from '../components/ui';

const plural = (n, word) => `${n || 0} ${n === 1 ? word : `${word}s`}`;

export default function Spaces() {
  const navigate = useNavigate();
  const [spaces, setSpaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = () => {
    setLoading(true);
    setFailed(false);
    axios.get('/api/spaces')
      .then(res => setSpaces(res.data.spaces || []))
      // This used to swallow the error and render an empty grid with no message
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  return (
    <div className="page-container">
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '24px 16px' }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Layers size={22} color="var(--nx-violet)" /> Spaces
        </h1>
        <p style={{ color: 'var(--text-sub)', marginBottom: 24 }}>
          Interest communities — posts, questions, and people in each topic.
        </p>

        {loading ? (
          <SkeletonList count={4} Item={SkeletonQuestionCard} />
        ) : failed ? (
          <ErrorState title="Could not load Spaces" onRetry={load} />
        ) : spaces.length === 0 ? (
          <EmptyState
            icon={Layers}
            title="No spaces yet"
            description="Interest communities will appear here once topics have activity."
          />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            {spaces.map(s => (
              <button
                key={s.id}
                type="button"
                className="feature-card"
                style={{ textAlign: 'left', cursor: 'pointer', border: 'none', width: '100%', fontFamily: 'inherit' }}
                onClick={() => navigate(`/spaces/${s.id}`)}
              >
                <div style={{ fontSize: 28, marginBottom: 8 }}>{s.emoji}</div>
                <h3 style={{ marginBottom: 6 }}>{s.label}</h3>
                <p style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                  {plural(s.memberCount, 'member')} · {plural(s.postCount, 'post')} · {plural(s.questionCount, 'question')}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
