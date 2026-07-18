import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { Image, Video, Send, Heart, MessageCircle, Share2, Trash2, UserPlus, Users, X, ChevronDown, Rss } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

function PostCard({ post, currentUser, onLike, onComment, onShare, onDelete }) {
  const [showComments, setShowComments] = useState(false);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const isLiked = post.likes?.includes(currentUser?._id || currentUser?.id);
  const isOwn = post.author?._id === (currentUser?._id || currentUser?.id);

  const handleComment = async () => {
    if (!comment.trim()) return;
    setSubmitting(true);
    try {
      await onComment(post._id, comment);
      setComment('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="post-card animate-fadeIn">
      <div className="post-header">
        <div onClick={() => {}} style={{ cursor: 'pointer' }}>
          {post.author?.avatar
            ? <img src={post.author.avatar} className="avatar" style={{ width: 40, height: 40 }} alt="" />
            : <div className="avatar-placeholder" style={{ width: 40, height: 40, fontSize: 16 }}>
                {post.author?.name?.[0]?.toUpperCase() || 'U'}
              </div>
          }
        </div>
        <div className="post-author-info" style={{ flex: 1 }}>
          <h4>{post.author?.name}</h4>
          <span>{formatDistanceToNow(new Date(post.createdAt), { addSuffix: true })}</span>
        </div>
        {post.author?.badges?.map(b => (
          <span key={b} className={`badge badge-${b}`}>{b}</span>
        ))}
        {isOwn && (
          <button className="btn btn-icon btn-danger btn-sm" onClick={() => onDelete(post._id)} title="Delete post">
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {post.content && <div className="post-content">{post.content}</div>}

      {post.media?.length > 0 && (
        <div className="post-media">
          {post.media.map((m, i) => (
            m.type === 'image'
              ? <img key={i} src={m.url} alt="Post media" />
              : <video key={i} src={m.url} controls />
          ))}
        </div>
      )}

      <div className="post-actions">
        <button className={`action-btn ${isLiked ? 'liked' : ''}`} onClick={() => onLike(post._id)}>
          <Heart size={16} fill={isLiked ? 'currentColor' : 'none'} />
          {post.likes?.length || 0}
        </button>
        <button className="action-btn" onClick={() => setShowComments(!showComments)}>
          <MessageCircle size={16} />
          {post.comments?.length || 0}
        </button>
        <button className="action-btn" onClick={() => onShare(post._id)}>
          <Share2 size={16} />
          {post.shares || 0}
        </button>
      </div>

      {showComments && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          {post.comments?.slice(-5).map((c, i) => (
            <div key={i} className="comment-item">
              <div className="avatar-placeholder" style={{ width: 28, height: 28, fontSize: 11, flexShrink: 0 }}>
                {c.author?.name?.[0]?.toUpperCase() || 'U'}
              </div>
              <div>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{c.author?.name}</span>
                <p style={{ fontSize: 14, color: 'var(--text-secondary)', margin: '2px 0 0' }}>{c.content}</p>
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <input
              className="form-input"
              placeholder="Write a comment..."
              value={comment}
              onChange={e => setComment(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleComment()}
              style={{ flex: 1, padding: '8px 14px' }}
            />
            <button className="btn btn-primary btn-sm" onClick={handleComment} disabled={submitting || !comment.trim()}>
              <Send size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Feed() {
  const { user, refreshUser } = useAuth();
  const navigate = useNavigate();
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState('');
  const [media, setMedia] = useState([]);
  const [posting, setPosting] = useState(false);
  const [postLimit, setPostLimit] = useState(null);
  const [postsToday, setPostsToday] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const fileRef = useRef();

  useEffect(() => {
    fetchPosts();
  }, []);

  const fetchPosts = async (p = 1) => {
    try {
      const res = await axios.get(`/api/posts?page=${p}&limit=10`);
      if (p === 1) setPosts(res.data.posts);
      else setPosts(prev => [...prev, ...res.data.posts]);
      setHasMore(p < res.data.pages);
      setPage(p);
    } catch (err) {
      toast.error('Failed to load posts');
    } finally {
      setLoading(false);
    }
  };

  const handlePost = async () => {
    if (!content.trim() && media.length === 0) return;
    setPosting(true);
    try {
      const formData = new FormData();
      if (content) formData.append('content', content);
      media.forEach(f => formData.append('media', f));

      const res = await axios.post('/api/posts', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setPosts(prev => [res.data.post, ...prev]);
      setContent('');
      setMedia([]);
      setPostLimit(res.data.postLimit);
      setPostsToday(res.data.postsToday);
      toast.success('Post published! 🚀');
      refreshUser();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to post');
    } finally {
      setPosting(false);
    }
  };

  const handleLike = async (postId) => {
    try {
      const res = await axios.post(`/api/posts/${postId}/like`);
      setPosts(prev => prev.map(p => {
        if (p._id !== postId) return p;
        const uid = user?._id || user?.id;
        return {
          ...p,
          likes: res.data.liked
            ? [...(p.likes || []), uid]
            : (p.likes || []).filter(id => id !== uid)
        };
      }));
    } catch { toast.error('Failed to like'); }
  };

  const handleComment = async (postId, content) => {
    try {
      const res = await axios.post(`/api/posts/${postId}/comment`, { content });
      setPosts(prev => prev.map(p => p._id === postId ? { ...p, comments: res.data.comments } : p));
    } catch { toast.error('Failed to comment'); }
  };

  const handleShare = async (postId) => {
    try {
      const res = await axios.post(`/api/posts/${postId}/share`);
      setPosts(prev => prev.map(p => p._id === postId ? { ...p, shares: res.data.shares } : p));
      toast.success('Post shared!');
    } catch { toast.error('Failed to share'); }
  };

  const handleDelete = async (postId) => {
    if (!confirm('Delete this post?')) return;
    try {
      await axios.delete(`/api/posts/${postId}`);
      setPosts(prev => prev.filter(p => p._id !== postId));
      toast.success('Post deleted');
    } catch { toast.error('Failed to delete'); }
  };

  const friendCount = user?.friends?.length || 0;
  const getDailyLimit = () => {
    if (friendCount === 0) return 0;
    if (friendCount === 1) return 1;
    if (friendCount < 10) return 2;
    return '∞';
  };
  const dailyLimit = getDailyLimit();

  return (
    <div className="page-container">
      <div className="feed-layout">
        {/* Main Feed */}
        <div>
          {/* Create Post */}
          <div className="glass-card" style={{ padding: 20, marginBottom: 20 }}>
            {friendCount === 0 ? (
              <div className="alert alert-warning" style={{ marginBottom: 0 }}>
                <Users size={18} />
                <div>
                  <strong>Add friends to start posting!</strong>
                  <p style={{ margin: '4px 0 0', fontSize: 13 }}>You need at least 1 friend to post on the public feed.</p>
                </div>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div className="avatar-placeholder" style={{ flexShrink: 0 }}>
                    {user?.name?.[0]?.toUpperCase() || 'U'}
                  </div>
                  <textarea
                    className="form-input"
                    placeholder={`What's on your mind, ${user?.name?.split(' ')[0]}?`}
                    value={content}
                    onChange={e => setContent(e.target.value)}
                    rows={3}
                    style={{ resize: 'none' }}
                  />
                </div>

                {media.length > 0 && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                    {media.map((f, i) => (
                      <div key={i} style={{ position: 'relative' }}>
                        <img src={URL.createObjectURL(f)} alt="" style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 8 }} />
                        <button onClick={() => setMedia(m => m.filter((_, j) => j !== i))}
                          style={{ position: 'absolute', top: -6, right: -6, background: 'var(--danger)', border: 'none', borderRadius: '50%', width: 20, height: 20, cursor: 'pointer', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
                  <input ref={fileRef} type="file" accept="image/*,video/*" multiple style={{ display: 'none' }}
                    onChange={e => setMedia(Array.from(e.target.files))} />
                  <button className="btn btn-secondary btn-sm" onClick={() => fileRef.current.click()}>
                    <Image size={15} /> Photo/Video
                  </button>
                  <div style={{ flex: 1 }} />
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {postsToday}/{dailyLimit} posts today
                  </span>
                  <button className="btn btn-primary btn-sm" onClick={handlePost}
                    disabled={posting || (!content.trim() && media.length === 0)}>
                    {posting ? <div className="spinner" /> : <Send size={15} />}
                    Post
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Posts */}
          {loading ? (
            [1,2,3].map(i => (
              <div key={i} className="post-card">
                <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                  <div className="skeleton" style={{ width: 40, height: 40, borderRadius: '50%', flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div className="skeleton" style={{ height: 14, width: '40%', marginBottom: 6 }} />
                    <div className="skeleton" style={{ height: 12, width: '25%' }} />
                  </div>
                </div>
                <div className="skeleton" style={{ height: 80 }} />
              </div>
            ))
          ) : posts.length === 0 ? (
            <div className="empty-state">
              <Rss size={48} style={{ margin: '0 auto 16px' }} />
              <h3>No posts yet</h3>
              <p>Be the first to share something with the community!</p>
            </div>
          ) : (
            <>
              {posts.map(post => (
                <PostCard key={post._id} post={post} currentUser={user}
                  onLike={handleLike} onComment={handleComment}
                  onShare={handleShare} onDelete={handleDelete} />
              ))}
              {hasMore && (
                <button className="btn btn-secondary" style={{ width: '100%' }} onClick={() => fetchPosts(page + 1)}>
                  <ChevronDown size={16} /> Load More
                </button>
              )}
            </>
          )}
        </div>

        {/* Sidebar */}
        <div className="sidebar-right">
          {/* Posting info card */}
          <div className="glass-card" style={{ padding: 20, marginBottom: 16 }}>
            <h4 style={{ fontSize: 14, marginBottom: 14, color: 'var(--text-secondary)' }}>📊 Posting Limits</h4>
            {[
              { range: '0 friends', limit: 'Cannot post', active: friendCount === 0 },
              { range: '1 friend', limit: '1 post/day', active: friendCount === 1 },
              { range: '2–9 friends', limit: '2 posts/day', active: friendCount >= 2 && friendCount < 10 },
              { range: '10+ friends', limit: 'Unlimited', active: friendCount >= 10 }
            ].map(r => (
              <div key={r.range} style={{
                display: 'flex', justifyContent: 'space-between', padding: '8px 10px',
                borderRadius: 8, marginBottom: 4, fontSize: 13,
                background: r.active ? 'rgba(124,58,237,0.1)' : 'transparent',
                border: r.active ? '1px solid rgba(124,58,237,0.3)' : '1px solid transparent'
              }}>
                <span style={{ color: r.active ? 'var(--primary-light)' : 'var(--text-muted)' }}>{r.range}</span>
                <span style={{ color: r.active ? 'white' : 'var(--text-muted)', fontWeight: r.active ? 600 : 400 }}>{r.limit}</span>
              </div>
            ))}
            <div style={{ marginTop: 12, padding: '10px', background: 'rgba(124,58,237,0.08)', borderRadius: 8, fontSize: 12, textAlign: 'center' }}>
              You have <strong style={{ color: 'var(--primary-light)' }}>{friendCount}</strong> friend{friendCount !== 1 ? 's' : ''}
            </div>
          </div>

          {/* Quick actions */}
          <div className="glass-card" style={{ padding: 20 }}>
            <h4 style={{ fontSize: 14, marginBottom: 14, color: 'var(--text-secondary)' }}>🚀 Quick Actions</h4>
            <button className="btn btn-secondary" style={{ width: '100%', marginBottom: 8, justifyContent: 'flex-start' }}
              onClick={() => navigate('/qa')}>
              <span>🤔</span> Ask a Question
            </button>
            <button className="btn btn-secondary" style={{ width: '100%', marginBottom: 8, justifyContent: 'flex-start' }}
              onClick={() => navigate('/leaderboard')}>
              <span>🏆</span> Leaderboard
            </button>
            <button className="btn btn-secondary" style={{ width: '100%', justifyContent: 'flex-start' }}
              onClick={() => navigate('/subscriptions')}>
              <span>💎</span> Upgrade Plan
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
