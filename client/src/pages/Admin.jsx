import { useCallback, useEffect, useState } from 'react';
import axios from '../services/api';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import { Navigate } from 'react-router-dom';
import { Shield, RefreshCw } from 'lucide-react';

export default function Admin() {
  const { user } = useAuth();
  const [stats, setStats] = useState(null);
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('open');
  const isAdmin = user?.role === 'admin';

  const load = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    try {
      const [s, r] = await Promise.all([
        axios.get('/api/admin/stats'),
        axios.get('/api/admin/reports', { params: { status: statusFilter } })
      ]);
      setStats(s.data.stats);
      setReports(r.data.reports || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Admin API failed');
    } finally {
      setLoading(false);
    }
  }, [isAdmin, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  if (!isAdmin) {
    return <Navigate to="/feed" replace />;
  }

  const setReportStatus = async (id, status) => {
    try {
      await axios.patch(`/api/admin/reports/${id}`, { status });
      toast.success(`Report ${status}`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Update failed');
    }
  };

  return (
    <div className="page-container" style={{ maxWidth: 900, margin: '0 auto', padding: '32px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Shield size={22} color="#0866FF" aria-hidden="true" /> Admin
        </h1>
        <button type="button" className="btn btn-secondary btn-sm" onClick={load}>
          <RefreshCw size={14} aria-hidden="true" /> Refresh
        </button>
      </div>

      {loading && !stats ? (
        <div className="spinner spinner-lg" style={{ margin: '40px auto' }} role="status" aria-label="Loading" />
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))', gap: 12, marginBottom: 24 }}>
            {stats && Object.entries(stats).map(([k, v]) => (
              <div key={k} className="glass-card" style={{ padding: 14, textAlign: 'center' }}>
                <div style={{ fontSize: 20, fontWeight: 800 }}>{v ?? '—'}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'capitalize' }}>{k}</div>
              </div>
            ))}
          </div>

          <div className="glass-card" style={{ padding: 20 }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }} role="tablist" aria-label="Report status">
              {['open', 'reviewing', 'resolved', 'dismissed', 'all'].map(s => (
                <button
                  key={s}
                  type="button"
                  className={`btn btn-sm ${statusFilter === s ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setStatusFilter(s)}
                  aria-selected={statusFilter === s}
                >
                  {s}
                </button>
              ))}
            </div>

            {!reports.length ? (
              <p style={{ color: 'var(--text-muted)' }}>No reports in this filter.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {reports.map(r => (
                  <div key={r.id} style={{ border: '1px solid var(--border-soft)', borderRadius: 8, padding: 12 }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>
                      {r.target_type} · {r.reason} · <span style={{ color: 'var(--text-muted)' }}>{r.status}</span>
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--text-sub)', marginBottom: 8 }}>
                      Target: {r.target_id}
                      {r.details ? ` — ${r.details}` : ''}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setReportStatus(r.id, 'reviewing')}>Reviewing</button>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => setReportStatus(r.id, 'resolved')}>Resolve</button>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setReportStatus(r.id, 'dismissed')}>Dismiss</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
