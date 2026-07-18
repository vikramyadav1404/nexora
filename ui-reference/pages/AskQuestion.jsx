import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { ArrowLeft, Send, Tag, HelpCircle, AlertCircle } from 'lucide-react';

export default function AskQuestion() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ title: '', body: '', tags: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const plan = user?.subscription?.plan || 'free';
  const planLimits = { free: 1, bronze: 5, silver: 10, gold: '∞' };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (form.title.trim().length < 10) { setError('Title must be at least 10 characters'); return; }
    if (form.body.trim().length < 20) { setError('Description must be at least 20 characters'); return; }

    setLoading(true);
    try {
      const res = await axios.post('/api/questions', form);
      toast.success('Question posted! 🎉');
      navigate(`/qa/${res.data.question._id}`);
    } catch (err) {
      const msg = err.response?.data?.message || 'Failed to post question';
      if (err.response?.status === 429) {
        setError(msg);
        toast.error(msg);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page-container">
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '32px 24px' }}>
        <button className="btn btn-secondary btn-sm" style={{ marginBottom: 20 }} onClick={() => navigate('/qa')}>
          <ArrowLeft size={15} /> Back to Q&A
        </button>

        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 28, fontFamily: 'var(--font-heading)', marginBottom: 8 }}>
            <HelpCircle size={24} style={{ display: 'inline', marginRight: 10, color: 'var(--primary-light)' }} />
            Ask a Question
          </h1>
          <div className="alert alert-info" style={{ marginTop: 12 }}>
            <AlertCircle size={16} />
            <div>
              Your <span className={`badge badge-plan-${plan}`}>{plan.toUpperCase()}</span> plan allows{' '}
              <strong>{planLimits[plan]} question{plan !== 'gold' ? 's' : ''}/day</strong>.
              {plan !== 'gold' && <span> <a href="/subscriptions" style={{ color: 'var(--primary-light)' }}>Upgrade</a> for more.</span>}
            </div>
          </div>
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 20 }}>{error}</div>}

        <div className="glass-card" style={{ padding: 28 }}>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label">Question Title *</label>
              <input
                type="text"
                className="form-input"
                placeholder="e.g. How do I reverse a linked list in JavaScript?"
                value={form.title}
                onChange={e => setForm({ ...form, title: e.target.value })}
                required
                minLength={10}
              />
              <small style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4, display: 'block' }}>
                Be specific and imagine you&apos;re asking a question to another person
              </small>
            </div>

            <div className="form-group">
              <label className="form-label">Description *</label>
              <textarea
                className="form-input"
                placeholder="Include all the information someone would need to answer your question. You can add code, examples, what you've tried, etc."
                value={form.body}
                onChange={e => setForm({ ...form, body: e.target.value })}
                rows={10}
                required
                minLength={20}
              />
            </div>

            <div className="form-group">
              <label className="form-label">
                <Tag size={14} style={{ display: 'inline', marginRight: 4 }} />
                Tags (comma separated)
              </label>
              <input
                type="text"
                className="form-input"
                placeholder="e.g. javascript, react, algorithms"
                value={form.tags}
                onChange={e => setForm({ ...form, tags: e.target.value })}
              />
              <small style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4, display: 'block' }}>
                Add up to 5 tags to describe what your question is about
              </small>
            </div>

            {/* Preview tags */}
            {form.tags && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 20 }}>
                {form.tags.split(',').map(t => t.trim()).filter(Boolean).slice(0, 5).map(tag => (
                  <span key={tag} className="tag">{tag}</span>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={() => navigate('/qa')}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={loading}>
                {loading ? <><div className="spinner" /> Posting...</> : <><Send size={15} /> Post Question</>}
              </button>
            </div>
          </form>
        </div>

        {/* Tips */}
        <div className="glass-card" style={{ padding: 20, marginTop: 20 }}>
          <h4 style={{ fontSize: 14, marginBottom: 12, color: 'var(--text-secondary)' }}>💡 Tips for a great question</h4>
          {[
            'Summarize your problem in a one-line title',
            'Describe exactly what you tried and what happened',
            'Add code examples when relevant',
            'Use tags to help others find your question',
            'Proofread your question before posting'
          ].map((tip, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: 'var(--text-muted)', marginBottom: 8 }}>
              <span style={{ color: 'var(--primary-light)', fontWeight: 700, flexShrink: 0 }}>{i + 1}.</span>
              {tip}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
