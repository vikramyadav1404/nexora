import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from '../services/api';
import toast from 'react-hot-toast';
import { Bell, CheckCheck } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

export default function Notifications() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const res = await axios.get('/api/notifications');
      setItems(res.data.notifications || []);
    } catch {
      toast.error('Failed to load notifications');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const markAll = async () => {
    await axios.post('/api/notifications/read-all');
    setItems(prev => prev.map(n => ({ ...n, read: true })));
    toast.success('All marked as read');
  };

  const openItem = async (n) => {
    if (!n.read) {
      try { await axios.post(`/api/notifications/${n.id || n._id}/read`); } catch {}
      setItems(prev => prev.map(x => (x.id === n.id || x._id === n._id) ? { ...x, read: true } : x));
    }
    if (n.link) navigate(n.link);
  };

  return (
    <div className="page-container">
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '24px 16px' }}>
        <div className="section-header">
          <h1 style={{ fontSize: 24, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Bell size={22} color="var(--fb-blue)" /> Notifications
          </h1>
          <button type="button" className="btn btn-secondary btn-sm" onClick={markAll}>
            <CheckCheck size={16} /> Mark all read
          </button>
        </div>

        {loading ? (
          <div className="spinner spinner-lg" style={{ margin: '40px auto' }} />
        ) : items.length === 0 ? (
          <div className="empty-state">
            <Bell size={40} style={{ margin: '0 auto 12px' }} />
            <h3>You&apos;re all caught up</h3>
            <p>New answers, follows, and rewards will show up here.</p>
          </div>
        ) : (
          <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
            {items.map(n => (
              <button
                key={n.id || n._id}
                type="button"
                onClick={() => openItem(n)}
                style={{
                  width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
                  padding: '14px 16px', borderBottom: '1px solid var(--border-soft)',
                  background: n.read ? 'transparent' : 'var(--fb-blue-soft)',
                  fontFamily: 'inherit'
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{n.title}</div>
                {n.body && <div style={{ fontSize: 13, color: 'var(--text-sub)' }}>{n.body}</div>}
                <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 6 }}>
                  {n.createdAt ? formatDistanceToNow(new Date(n.createdAt), { addSuffix: true }) : ''}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
