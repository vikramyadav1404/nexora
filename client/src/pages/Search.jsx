import { useState } from 'react';
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
                      {(p.interests || []).slice(0, 3).join(' · ') || p.email}
                    </div>
                  </div>
                </Link>
              ))}
            </Section>

            <Section title="Questions" icon={<HelpCircle size={18} />} empty={!results.questions?.length}>
              {(results.questions || []).map(qItem => (
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
            </Section>

            <Section title="Posts" icon={<FileText size={18} />} empty={!results.posts?.length}>
              {(results.posts || []).map(p => (
                <div key={p._id || p.id} className="post-card">
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>{p.author?.name}</div>
                  <div className="post-content">{p.content}</div>
                </div>
              ))}
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
