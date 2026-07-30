import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import axios from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { Search, Plus, CheckCircle, MessageSquare, ThumbsUp, Eye, Clock } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Avatar, EmptyState, ErrorState, SkeletonList, SkeletonQuestionCard } from '../components/ui';
import useInfiniteScroll from '../hooks/useInfiniteScroll';
import useReducedMotion from '../hooks/useReducedMotion';

const LIMIT = 10;

export default function QA() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const reduced = useReducedMotion();

  const [questions, setQuestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  const fetchQuestions = useCallback(
    async (p = 1, q = '') => {
      if (p === 1) {
        setLoading(true);
        setLoadError(false);
      } else {
        setLoadingMore(true);
      }
      try {
        const res = await axios.get('/api/questions', {
          params: { page: p, limit: LIMIT, sort, search: q }
        });
        const incoming = res.data.questions || [];
        setQuestions((prev) => {
          if (p === 1) return incoming;
          const seen = new Set(prev.map((x) => x._id || x.id));
          return [...prev, ...incoming.filter((x) => !seen.has(x._id || x.id))];
        });
        setTotal(res.data.total);
        setPage(p);
      } catch {
        if (p === 1) setLoadError(true);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [sort]
  );

  useEffect(() => {
    fetchQuestions(1, search);
    // Re-run on sort change only; search is submitted explicitly with Enter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort]);

  const hasMore = questions.length < total;
  const sentinelRef = useInfiniteScroll({
    hasMore,
    loading: loading || loadingMore,
    onLoadMore: () => fetchQuestions(page + 1, search)
  });

  const planLimits = { free: 1, bronze: 5, silver: 10, gold: '∞' };
  const plan = user?.subscription?.plan || 'free';

  return (
    <div className="page-container">
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '32px 24px' }}>
        <div className="section-header" style={{ marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700 }}>Q&amp;A Community</h1>
            <p style={{ color: 'var(--text-sub)', marginTop: 4, fontSize: 'var(--fs-base)' }}>
              {total} questions · Your plan:{' '}
              <span className={`badge badge-plan-${plan}`}>{plan.toUpperCase()}</span>
              <span style={{ marginLeft: 8, fontSize: 13 }}>({planLimits[plan]} questions/day)</span>
            </p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => navigate('/ask')}>
            <Plus size={16} /> Ask Question
          </button>
        </div>

        <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
          <div className="input-wrapper" style={{ flex: 1, minWidth: 200 }}>
            <Search size={16} className="input-icon" />
            <input
              className="form-input"
              placeholder="Search questions…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && fetchQuestions(1, search)}
            />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[
              { key: 'newest', label: 'Newest', icon: <Clock size={14} /> },
              { key: 'votes', label: 'Top Voted', icon: <ThumbsUp size={14} /> },
              { key: 'unanswered', label: 'Unanswered', icon: <MessageSquare size={14} /> }
            ].map((s) => (
              <button
                key={s.key}
                type="button"
                className={`btn btn-sm ${sort === s.key ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setSort(s.key)}
              >
                {s.icon} {s.label}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <SkeletonList count={4} Item={SkeletonQuestionCard} />
        ) : loadError ? (
          <ErrorState
            title="Could not load questions"
            onRetry={() => fetchQuestions(1, search)}
          />
        ) : questions.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title={search ? 'No matches' : 'No questions yet'}
            description={
              search
                ? `Nothing matched “${search}”. Try a different search.`
                : 'Be the first to ask — someone here probably knows the answer.'
            }
            action={
              <button type="button" className="btn btn-primary" onClick={() => navigate('/ask')}>
                <Plus size={16} /> Ask a question
              </button>
            }
          />
        ) : (
          <>
            {questions.map((q, i) => (
              <motion.div
                key={q._id || q.id}
                className={`question-card ${q.isResolved ? 'resolved' : ''}`}
                onClick={() => navigate(`/qa/${q._id || q.id}`)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') navigate(`/qa/${q._id || q.id}`);
                }}
                initial={reduced ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={
                  reduced
                    ? { duration: 0 }
                    : { duration: 0.3, ease: [0.16, 1, 0.3, 1], delay: Math.min(i, 5) * 0.035 }
                }
              >
                <div style={{ display: 'flex', gap: 16 }}>
                  <div
                    style={{
                      display: 'flex', flexDirection: 'column', gap: 8,
                      alignItems: 'center', minWidth: 60, flexShrink: 0
                    }}
                  >
                    {/* These stat chips used to use hardcoded rgba() from the old
                        dark theme — invisible borders in light mode. Now tokens. */}
                    <div
                      style={{
                        textAlign: 'center', padding: '6px 10px', borderRadius: 'var(--r-sm)',
                        background: q.upvotes?.length > 0 ? 'var(--nx-violet-soft)' : 'transparent',
                        border: '1px solid var(--border-soft)'
                      }}
                    >
                      <div style={{ fontSize: 18, fontWeight: 700 }}>{q.upvotes?.length || 0}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>votes</div>
                    </div>
                    <div
                      style={{
                        textAlign: 'center', padding: '6px 10px', borderRadius: 'var(--r-sm)',
                        background: q.isResolved ? 'var(--green-muted)' : 'transparent',
                        border: `1px solid ${q.isResolved ? 'var(--green)' : 'var(--border-soft)'}`
                      }}
                    >
                      <div
                        style={{
                          fontSize: 18, fontWeight: 700,
                          color: q.isResolved ? 'var(--green)' : 'inherit'
                        }}
                      >
                        {q.answers?.length || 0}
                      </div>
                      <div style={{ fontSize: 11, color: q.isResolved ? 'var(--green)' : 'var(--text-muted)' }}>
                        {q.isResolved ? '✓ ans' : 'ans'}
                      </div>
                    </div>
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h3
                      style={{
                        fontSize: 'var(--fs-md)', fontWeight: 650, marginBottom: 6,
                        color: 'var(--text-primary)', lineHeight: 'var(--leading-snug)'
                      }}
                    >
                      {q.isResolved && (
                        <CheckCircle
                          size={14}
                          style={{ color: 'var(--green)', marginRight: 6, display: 'inline' }}
                        />
                      )}
                      {q.title}
                    </h3>
                    <p
                      style={{
                        fontSize: 14, color: 'var(--text-muted)', marginBottom: 10,
                        display: '-webkit-box', WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical', overflow: 'hidden'
                      }}
                    >
                      {q.body}
                    </p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      {q.tags?.slice(0, 4).map((tag) => (
                        <span key={tag} className="tag">{tag}</span>
                      ))}
                      <div style={{ flex: 1 }} />
                      <div
                        style={{
                          display: 'flex', alignItems: 'center', gap: 12,
                          fontSize: 12, color: 'var(--text-muted)'
                        }}
                      >
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Eye size={12} /> {q.views}
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Avatar src={q.author?.avatar} name={q.author?.name} size={20} />
                          {q.author?.name}
                        </span>
                        <span>{formatDistanceToNow(new Date(q.createdAt), { addSuffix: true })}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>
            ))}

            <div ref={sentinelRef} className="feed-sentinel" />
            {loadingMore && <SkeletonQuestionCard />}
            {!hasMore && questions.length > 4 && (
              <p
                style={{
                  textAlign: 'center', color: 'var(--text-faint)',
                  fontSize: 'var(--fs-sm)', padding: 'var(--space-6) 0'
                }}
              >
                That is every question so far
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
