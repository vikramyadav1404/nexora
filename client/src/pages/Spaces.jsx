import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from '../api';
import { Layers } from 'lucide-react';

export default function Spaces() {
  const navigate = useNavigate();
  const [spaces, setSpaces] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    axios.get('/api/spaces')
      .then(res => setSpaces(res.data.spaces || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="page-container">
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '24px 16px' }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Layers size={22} color="var(--fb-blue)" /> Spaces
        </h1>
        <p style={{ color: 'var(--text-sub)', marginBottom: 24 }}>
          Interest communities — posts, questions, and people in each topic.
        </p>

        {loading ? (
          <div className="spinner spinner-lg" style={{ margin: '40px auto' }} />
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
                  {s.memberCount || 0} members · {s.postCount || 0} posts · {s.questionCount || 0} Qs
                </p>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
