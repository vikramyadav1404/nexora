import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from '../services/api';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import { ArrowLeft, ChevronUp, ChevronDown, CheckCircle, Send, Trash2, Award, Eye } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Avatar, ErrorState, SkeletonList, SkeletonQuestionCard } from '../components/ui';

function VoteButtons({ upvotes, downvotes, onUpvote, onDownvote, currentUserId }) {
  const upvoted = upvotes?.includes(currentUserId);
  const downvoted = downvotes?.includes(currentUserId);
  const score = (upvotes?.length || 0) - (downvotes?.length || 0);
  return (
    <div className="vote-buttons">
      <button className={`vote-btn ${upvoted ? 'upvoted' : ''}`} onClick={onUpvote} title="Upvote">
        <ChevronUp size={16} />
      </button>
      <span className="vote-count" style={{ color: score > 0 ? 'var(--success)' : score < 0 ? 'var(--danger)' : 'var(--text-muted)' }}>
        {score}
      </span>
      <button className={`vote-btn ${downvoted ? 'downvoted' : ''}`} onClick={onDownvote} title="Downvote">
        <ChevronDown size={16} />
      </button>
    </div>
  );
}

export default function QuestionDetail() {
  const { id } = useParams();
  const { user, refreshUser } = useAuth();
  const navigate = useNavigate();
  const [question, setQuestion] = useState(null);
  const [loading, setLoading] = useState(true);
  const [answerBody, setAnswerBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const currentUserId = user?._id || user?.id;

  useEffect(() => { fetchQuestion(); }, [id]);

  const fetchQuestion = async () => {
    try {
      const res = await axios.get(`/api/questions/${id}`);
      setQuestion(res.data.question);
    } catch {
      // Leave `question` null so the retryable ErrorState renders instead of
      // bouncing the user back to /qa with only a toast.
      setQuestion(null);
    } finally { setLoading(false); }
  };

  const handleVoteQuestion = async (type) => {
    try {
      await axios.post(`/api/questions/${id}/vote`, { type });
      setQuestion(prev => ({
        ...prev,
        upvotes: type === 'up' ? (prev.upvotes.includes(currentUserId)
          ? prev.upvotes.filter(x => x !== currentUserId)
          : [...prev.upvotes, currentUserId]) : prev.upvotes,
        downvotes: type === 'down' ? (prev.downvotes.includes(currentUserId)
          ? prev.downvotes.filter(x => x !== currentUserId)
          : [...prev.downvotes, currentUserId]) : prev.downvotes
      }));
    } catch (err) { toast.error(err.response?.data?.message || 'Failed to vote'); }
  };

  const handleVoteAnswer = async (answerId, type) => {
    try {
      await axios.post(`/api/answers/${answerId}/vote`, { type });
      setQuestion(prev => ({
        ...prev,
        answers: prev.answers.map(a => {
          if (a._id !== answerId) return a;
          return {
            ...a,
            upvotes: type === 'up' ? (a.upvotes.includes(currentUserId)
              ? a.upvotes.filter(x => x !== currentUserId)
              : [...a.upvotes, currentUserId]) : a.upvotes,
            downvotes: type === 'down' ? (a.downvotes.includes(currentUserId)
              ? a.downvotes.filter(x => x !== currentUserId)
              : [...a.downvotes, currentUserId]) : a.downvotes
          };
        })
      }));
      refreshUser();
    } catch (err) { toast.error(err.response?.data?.message || 'Failed to vote'); }
  };

  const handleSubmitAnswer = async () => {
    if (!answerBody.trim()) return;
    setSubmitting(true);
    try {
      const res = await axios.post(`/api/answers/${id}`, { body: answerBody });
      setQuestion(prev => ({ ...prev, answers: [...(prev.answers || []), res.data.answer] }));
      setAnswerBody('');
      toast.success(`Answer posted! +${res.data.pointsEarned} points earned 🎉`);
      refreshUser();
    } catch (err) { toast.error(err.response?.data?.message || 'Failed to post answer'); }
    finally { setSubmitting(false); }
  };

  const handleAcceptAnswer = async (answerId) => {
    try {
      await axios.post(`/api/answers/${answerId}/accept`);
      setQuestion(prev => ({
        ...prev,
        isResolved: true,
        acceptedAnswer: answerId,
        answers: prev.answers.map(a => ({ ...a, isAccepted: a._id === answerId }))
      }));
      toast.success('Answer accepted! ✅');
    } catch (err) { toast.error(err.response?.data?.message || 'Failed'); }
  };

  const handleDeleteAnswer = async (answerId) => {
    if (!confirm('Delete this answer? Points will be deducted.')) return;
    try {
      await axios.delete(`/api/answers/${answerId}`);
      setQuestion(prev => ({ ...prev, answers: prev.answers.filter(a => a._id !== answerId) }));
      toast.success('Answer deleted');
      refreshUser();
    } catch { toast.error('Failed to delete'); }
  };

  // A content-shaped skeleton beats a blocking spinner — the page keeps its
  // geometry, so nothing jumps when the real answer arrives.
  if (loading) return (
    <div className="page-container">
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '32px 24px' }}>
        <SkeletonQuestionCard />
        <SkeletonList count={2} Item={SkeletonQuestionCard} />
      </div>
    </div>
  );

  if (!question) return (
    <div className="page-container">
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '32px 24px' }}>
        <ErrorState
          title="Question unavailable"
          description="This question may have been deleted, or we could not reach the server."
          onRetry={() => { setLoading(true); fetchQuestion(); }}
        />
      </div>
    </div>
  );

  const isAuthor = question.author?._id === currentUserId;

  return (
    <div className="page-container">
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '32px 24px' }}>
        <button className="btn btn-secondary btn-sm" style={{ marginBottom: 20 }} onClick={() => navigate('/qa')}>
          <ArrowLeft size={15} /> All Questions
        </button>

        {/* Question */}
        <div className="glass-card" style={{ padding: 24, marginBottom: 24 }}>
          <div style={{ display: 'flex', gap: 20 }}>
            <VoteButtons
              upvotes={question.upvotes}
              downvotes={question.downvotes}
              currentUserId={currentUserId}
              onUpvote={() => handleVoteQuestion('up')}
              onDownvote={() => handleVoteQuestion('down')}
            />
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                {question.isResolved && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--success)', fontSize: 13, fontWeight: 600 }}>
                    <CheckCircle size={15} /> Resolved
                  </span>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, color: 'var(--text-muted)' }}>
                  <Eye size={13} /> {question.views} views
                </div>
              </div>
              <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 16, lineHeight: 1.4 }}>{question.title}</h1>
              <div style={{ fontSize: 15, lineHeight: 1.8, color: 'var(--text-secondary)', marginBottom: 16, whiteSpace: 'pre-wrap' }}>
                {question.body}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
                {question.tags?.map(tag => <span key={tag} className="tag">{tag}</span>)}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--text-muted)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Avatar
                    src={question.author?.avatarThumbUrl || question.author?.avatar}
                    name={question.author?.name}
                    userId={question.author?._id || question.author?.id}
                    size={26}
                  />
                  <span style={{ fontWeight: 500, color: 'var(--text-secondary)' }}>{question.author?.name}</span>
                </div>
                <span>·</span>
                <span>{formatDistanceToNow(new Date(question.createdAt), { addSuffix: true })}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Answers */}
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>
          {question.answers?.length || 0} Answer{question.answers?.length !== 1 ? 's' : ''}
        </h2>

        {question.answers?.map(answer => {
          const isAnswerAuthor = answer.author?._id === currentUserId;
          const canAccept = isAuthor && !question.isResolved;
          return (
            <div key={answer._id} className={`answer-card ${answer.isAccepted ? 'accepted' : ''}`}>
              {answer.isAccepted && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--success)', fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
                  <CheckCircle size={15} /> Accepted Answer
                </div>
              )}
              <div style={{ display: 'flex', gap: 16 }}>
                <VoteButtons
                  upvotes={answer.upvotes}
                  downvotes={answer.downvotes}
                  currentUserId={currentUserId}
                  onUpvote={() => handleVoteAnswer(answer._id, 'up')}
                  onDownvote={() => handleVoteAnswer(answer._id, 'down')}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, lineHeight: 1.8, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', marginBottom: 14 }}>
                    {answer.body}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-muted)' }}>
                      <Avatar
                        src={answer.author?.avatarThumbUrl || answer.author?.avatar}
                        name={answer.author?.name}
                        userId={answer.author?._id || answer.author?.id}
                        size={24}
                      />
                      {answer.author?.name}
                      <span>·</span>
                      {formatDistanceToNow(new Date(answer.createdAt), { addSuffix: true })}
                    </div>
                    <div style={{ flex: 1 }} />
                    {canAccept && (
                      <button className="btn btn-success btn-sm" onClick={() => handleAcceptAnswer(answer._id)}>
                        <CheckCircle size={13} /> Accept
                      </button>
                    )}
                    {isAnswerAuthor && (
                      <button className="btn btn-danger btn-sm" onClick={() => handleDeleteAnswer(answer._id)}>
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {/* Post Answer */}
        <div className="glass-card" style={{ padding: 24, marginTop: 24 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>
            <Award size={18} style={{ color: 'var(--accent)', marginRight: 8, display: 'inline' }} />
            Your Answer <span style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 400 }}>(earn +5 points)</span>
          </h3>
          <textarea
            className="form-input"
            placeholder="Write your answer here... Be detailed and helpful!"
            value={answerBody}
            onChange={e => setAnswerBody(e.target.value)}
            rows={6}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn btn-primary" onClick={handleSubmitAnswer}
              disabled={submitting || !answerBody.trim()}>
              {submitting ? <div className="spinner" /> : <Send size={15} />}
              Post Answer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
