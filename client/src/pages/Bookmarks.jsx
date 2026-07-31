import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from '../services/api';
import toast from 'react-hot-toast';
import { Bookmark, Trash2 } from 'lucide-react';
import { SkeletonList, SkeletonPostCard } from '../components/ui';

export default function Bookmarks() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const res = await axios.get('/api/bookmarks');
      setItems(res.data.bookmarks || []);
    } catch {
      toast.error('Failed to load bookmarks');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const remove = async (type, id) => {
    await axios.delete('/api/bookmarks', { data: { type, id } });
    setItems(prev => prev.filter(b => !(b.type === type && b.id === id)));
    toast.success('Removed');
  };

  return (
    <div className="page-container">
      <div style={{ maxWidth: 700, margin: '0 auto', padding: '24px 16px' }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Bookmark size={22} color="var(--nx-violet)" /> Saved
        </h1>

        {loading ? (
          <SkeletonList count={3} Item={SkeletonPostCard} />
        ) : items.length === 0 ? (
          <div className="empty-state">
            <Bookmark size={40} style={{ margin: '0 auto 12px' }} />
            <h3>No bookmarks yet</h3>
            <p>Save posts and questions to find them later.</p>
          </div>
        ) : (
          items.map(b => (
            <div key={`${b.type}-${b.id}`} className="glass-card" style={{ padding: 16, marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => {
                  if (b.type === 'question') navigate(`/qa/${b.id}`);
                  else navigate('/feed');
                }}>
                  <span className="badge badge-plan-free" style={{ marginBottom: 8 }}>{b.type}</span>
                  <div style={{ fontWeight: 600 }}>
                    {b.type === 'question' ? b.item?.title : (b.item?.content || '').slice(0, 120)}
                  </div>
                </div>
                <button type="button" className="btn btn-icon btn-sm" onClick={() => remove(b.type, b.id)} title="Remove">
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
