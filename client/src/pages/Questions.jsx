import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from '../services/api';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import { Search, Plus, CheckCircle, MessageSquare, ThumbsUp, Eye, Filter, Tag, Clock } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

export default function QA() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [questions, setQuestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const LIMIT = 10;

  useEffect(() => {
    fetchQuestions();
  }, [sort]);

  const fetchQuestions = async (p = 1, q = search) => {
    setLoading(true);
    try {
      const res = await axios.get('/api/questions', { params: { page: p, limit: LIMIT, sort, search: q } });
      if (p === 1) setQuestions(res.data.questions);
      else setQuestions(prev => [...prev, ...res.data.questions]);
      setTotal(res.data.total);
      setPage(p);
    } catch { toast.error('Failed to load questions'); }
    finally { setLoading(false); }
  };

  const planLimits = { free: 1, bronze: 5, silver: 10, gold: '∞' };
  const plan = user?.subscription?.plan || 'free';

  return (
    <div className="page-container">
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '32px 24px' }}>
        {/* Header */}
        <div className="section-header" style={{ marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 700 }}>
              Q&A Community
            </h1>
            <p style={{ color: 'var(--text-sub)', marginTop: 4, fontSize: 15 }}>
              {total} questions · Your plan: <span className={`badge badge-plan-${plan}`}>{plan.toUpperCase()}</span>
              <span style={{ marginLeft: 8, fontSize: 13 }}>({planLimits[plan]} questions/day)</span>
            </p>
          </div>
          <button className="btn btn-primary" onClick={() => navigate('/ask')}>
            <Plus size={16} /> Ask Question
          </button>
        </div>

        {/* Search + Filter */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
          <div className="input-wrapper" style={{ flex: 1, minWidth: 200 }}>
            <Search size={16} className="input-icon" />
            <input
              className="form-input"
              placeholder="Search questions..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && fetchQuestions(1, search)}
            />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[
              { key: 'newest', label: 'Newest', icon: <Clock size={14} /> },
              { key: 'votes', label: 'Top Voted', icon: <ThumbsUp size={14} /> },
              { key: 'unanswered', label: 'Unanswered', icon: <MessageSquare size={14} /> }
            ].map(s => (
              <button key={s.key}
                className={`btn btn-sm ${sort === s.key ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setSort(s.key)}>
                {s.icon} {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Questions List */}
        {loading && page === 1 ? (
          [1,2,3,4].map(i => (
            <div key={i} className="question-card">
              <div className="skeleton" style={{ height: 18, width: '60%', marginBottom: 10 }} />
              <div className="skeleton" style={{ height: 14, width: '80%', marginBottom: 14 }} />
              <div style={{ display: 'flex', gap: 8 }}>
                {[1,2].map(j => <div key={j} className="skeleton" style={{ height: 22, width: 60 }} />)}
              </div>
            </div>
          ))
        ) : questions.length === 0 ? (
          <div className="empty-state">
            <MessageSquare size={48} style={{ margin: '0 auto 16px' }} />
            <h3>No questions yet</h3>
            <p>Be the first to ask a question!</p>
            <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => navigate('/ask')}>
              <Plus size={16} /> Ask Question
            </button>
          </div>
        ) : (
          <>
            {questions.map(q => (
              <div key={q._id} className={`question-card ${q.isResolved ? 'resolved' : ''}`}
                onClick={() => navigate(`/qa/${q._id}`)}>
                <div style={{ display: 'flex', gap: 16 }}>
                  {/* Stats column */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', minWidth: 60, flexShrink: 0 }}>
                    <div style={{ textAlign: 'center', padding: '6px 10px', borderRadius: 8,
                      background: q.upvotes?.length > 0 ? 'rgba(124,58,237,0.1)' : 'transparent',
                      border: '1px solid rgba(255,255,255,0.08)' }}>
                      <div style={{ fontSize: 18, fontWeight: 700 }}>{q.upvotes?.length || 0}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>votes</div>
                    </div>
                    <div style={{ textAlign: 'center', padding: '6px 10px', borderRadius: 8,
                      background: q.isResolved ? 'rgba(16,185,129,0.1)' : 'transparent',
                      border: q.isResolved ? '1px solid rgba(16,185,129,0.3)' : '1px solid rgba(255,255,255,0.08)' }}>
                      <div style={{ fontSize: 18, fontWeight: 700, color: q.isResolved ? 'var(--success)' : 'inherit' }}>
                        {q.answers?.length || 0}
                      </div>
                      <div style={{ fontSize: 11, color: q.isResolved ? 'var(--success)' : 'var(--text-muted)' }}>
                        {q.isResolved ? '✓ ans' : 'ans'}
                      </div>
                    </div>
                  </div>

                  {/* Content */}
                  <div style={{ flex: 1 }}>
                    <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 6, color: 'var(--text-primary)', lineHeight: 1.4 }}>
                      {q.isResolved && <CheckCircle size={14} style={{ color: 'var(--success)', marginRight: 6, display: 'inline' }} />}
                      {q.title}
                    </h3>
                    <p style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 10, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                      {q.body}
                    </p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      {q.tags?.slice(0, 4).map(tag => (
                        <span key={tag} className="tag">{tag}</span>
                      ))}
                      <div style={{ flex: 1 }} />
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: 'var(--text-muted)' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Eye size={12} /> {q.views}
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          {q.author?.avatar
                            ? <img src={q.author.avatar} style={{ width: 20, height: 20, borderRadius: '50%', objectFit: 'cover' }} alt="" />
                            : <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--gradient-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: 'white' }}>
                                {q.author?.name?.[0]}
                              </div>
                          }
                          {q.author?.name}
                        </span>
                        <span>{formatDistanceToNow(new Date(q.createdAt), { addSuffix: true })}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {questions.length < total && (
              <button className="btn btn-secondary" style={{ width: '100%', marginTop: 8 }}
                onClick={() => fetchQuestions(page + 1)}>
                Load More Questions
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
