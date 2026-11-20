import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import axios from '../services/api';
import { Search as SearchIcon, Users, FileText, HelpCircle, Layers } from 'lucide-react';
import { Avatar, ErrorState } from '../components/ui';
import useResource from '../hooks/useResource';

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const EMPTY = { people: [], posts: [], questions: [], spaces: [] };
  const urlQuery = (params.get('q') || '').trim();
  const [q, setQ] = useState(urlQuery);

  /*
   * Keyed on the URL query, which fixes two things at once.
   *
   * The effect this replaces ran on mount only, and App.jsx keys <Routes> on
   * location.pathname alone -- so searching from the navbar while already on
   * /search changed the URL and nothing else: same input, same results, no
   * indication anything had happened. A dependency makes that a re-run.
   *
   * And the old catch reset results to empty, which rendered "No results" in
   * every section on a 500 -- telling the user their query matched nothing when
   * the search never ran.
   */
  const res = useResource(
    (signal) => axios.get('/api/search', { params: { q: urlQuery }, signal }).then(r => r.data),
    [urlQuery],
    { enabled: urlQuery.length >= 2, initialData: EMPTY }
  );

  const results = res.data || EMPTY;
  const loading = res.isLoading;

  /*
   * Further pages of the ranked lists (migration 022). The first response
   * carries a cursor per list in `more`; each "Load more" asks for the next
   * page of that one list and hands back the cursor after it. Reset whenever
   * a new search result arrives, so a cursor never outlives its query.
   */
  const [extra, setExtra] = useState({ posts: [], questions: [] });
  const [cursors, setCursors] = useState({ posts: null, questions: null });
  const [loadingMore, setLoadingMore] = useState(null);
  const [moreFailed, setMoreFailed] = useState(null);

  useEffect(() => {
    setExtra({ posts: [], questions: [] });
    setCursors({ posts: res.data?.more?.posts || null, questions: res.data?.more?.questions || null });
    setMoreFailed(null);
  }, [res.data]);

  const loadMore = async (type) => {
    const cursor = cursors[type];
    if (!cursor || loadingMore) return;
    setLoadingMore(type);
    setMoreFailed(null);
    try {
      const { data } = await axios.get('/api/search', { params: { q: urlQuery, type, cursor } });
      setExtra(prev => {
        const shown = new Set([...(results[type] || []), ...prev[type]].map(x => x._id || x.id));
        const fresh = (data.items || []).filter(x => !shown.has(x._id || x.id));
        return { ...prev, [type]: [...prev[type], ...fresh] };
      });
      setCursors(prev => ({ ...prev, [type]: data.nextCursor || null }));
    } catch {
      // Keep what is shown and the cursor, so the same button can retry.
      setMoreFailed(type);
    } finally {
      setLoadingMore(null);
    }
  };

  const questionList = [...(results.questions || []), ...extra.questions];
  const postList = [...(results.posts || []), ...extra.posts];

  const submit = (e) => {
    e.preventDefault();
    // Writing the param is now the whole action -- the resource follows it.
    setParams(q.trim() ? { q: q.trim() } : {});
  };

  return (
    <div className="page-container">
      <div style={{ maxWidth: 800, margin: '0 auto', padding: '24px 16px' }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 16 }}>Search</h1>
        <form onSubmit={submit} style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          <div className="input-wrapper" style={{ flex: 1 }}>
            <SearchIcon size={16} className="input-icon" />
            <input
              className="form-input"
              placeholder="People, posts, questions, spaces…"
              value={q}
              onChange={e => setQ(e.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-primary">Search</button>
        </form>

        {loading && <div className="spinner spinner-lg" style={{ margin: '40px auto' }} />}

        {/* Before the empty sections, not after: a failed search has no
            results, so rendering the sections first says "No results" for a
            query that was never actually run. */}
        {res.isError && (
          <ErrorState
            title="Search is unavailable right now"
            description="This is us, not your query. Try again in a moment."
            onRetry={res.reload}
          />
        )}

        {!loading && !res.isError && urlQuery.length >= 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <Section title="Spaces" icon={<Layers size={18} />} empty={!results.spaces?.length}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {(results.spaces || []).map(s => (
                  <button
                    key={s.id}
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => navigate(`/spaces/${s.id}`)}
                  >
                    {s.emoji} {s.label}
                  </button>
                ))}
              </div>
            </Section>

            <Section title="People" icon={<Users size={18} />} empty={!results.people?.length}>
              {(results.people || []).map(p => (
                <Link
                  key={p.id}
                  to={`/profile/${p.id}`}
                  className="side-link"
                  style={{ padding: '10px 8px' }}
                >
                  <Avatar
                    src={p.avatarThumbUrl || p.avatar}
                    name={p.name}
                    userId={p._id || p.id}
                    size={36}
                  />
                  <div>
                    <div style={{ fontWeight: 600 }}>{p.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                      {/* Was `|| p.email` — a search for a common name printed
                          ten strangers' addresses on screen. Bio is the right
                          fallback: it is something people chose to publish. */}
                      {(p.interests || []).slice(0, 3).join(' · ') || p.bio || ''}
                    </div>
                  </div>
                </Link>
              ))}
            </Section>

            <Section title="Questions" icon={<HelpCircle size={18} />} empty={!questionList.length}>
              {questionList.map(qItem => (
                <button
                  key={qItem._id || qItem.id}
                  type="button"
                  className="question-card"
                  style={{ width: '100%', textAlign: 'left' }}
                  onClick={() => navigate(`/qa/${qItem._id || qItem.id}`)}
                >
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>{qItem.title}</div>
                  <div style={{ fontSize: 13, color: 'var(--text-sub)' }}>
                    {(qItem.body || '').slice(0, 120)}
                  </div>
                </button>
              ))}
              <LoadMore
                visible={!!cursors.questions}
                loading={loadingMore === 'questions'}
                failed={moreFailed === 'questions'}
                onClick={() => loadMore('questions')}
                label="Load more questions"
              />
            </Section>

            <Section title="Posts" icon={<FileText size={18} />} empty={!postList.length}>
              {postList.map(p => (
                <div key={p._id || p.id} className="post-card">
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>{p.author?.name}</div>
                  <div className="post-content">{p.content}</div>
                </div>
              ))}
              <LoadMore
                visible={!!cursors.posts}
                loading={loadingMore === 'posts'}
                failed={moreFailed === 'posts'}
                onClick={() => loadMore('posts')}
                label="Load more posts"
              />
            </Section>
          </div>
        )}

        {!loading && q.length < 2 && (
          <div className="empty-state">
            <SearchIcon size={40} style={{ margin: '0 auto 12px' }} />
            <h3>Search Nexora</h3>
            <p>Type at least 2 characters to find people, posts, questions, and spaces.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, icon, empty, children }) {
  return (
    <div className="glass-card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontWeight: 700 }}>
        {icon} {title}
      </div>
      {empty ? <p style={{ color: 'var(--text-faint)', fontSize: 14 }}>No results</p> : children}
    </div>
  );
}

function LoadMore({ visible, loading, failed, onClick, label }) {
  if (!visible) return null;
  return (
    <div style={{ marginTop: 12, textAlign: 'center' }}>
      {failed && (
        <p style={{ color: 'var(--text-faint)', fontSize: 13, marginBottom: 8 }}>
          Couldn't load more. Try again.
        </p>
      )}
      <button type="button" className="btn btn-secondary btn-sm" onClick={onClick} disabled={loading}>
        {loading ? 'Loading…' : label}
      </button>
    </div>
  );
}
