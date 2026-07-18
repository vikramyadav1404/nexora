import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import axios from '../services/api';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import {
  Image, Send, ThumbsUp, MessageCircle, Share2, Trash2, Users, X,
  ChevronDown, Home, HelpCircle, CreditCard, Trophy, Settings, User,
  BarChart2, Globe, Video, Smile, Bookmark
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { TRANSLATIONS } from '../i18n/translations';
import { mediaUrl } from '../utils/mediaUrl';

function postIdOf(post) {
  return post?._id || post?.id;
}

function PostCard({ post, currentUser, onLike, onComment, onShare, onDelete, onProfile }) {
  const [showComments, setShowComments] = useState(false);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const uid = currentUser?._id || currentUser?.id;
  const authorId = post.author?._id || post.author?.id;
  const pid = postIdOf(post);
  const isLiked = post.likes?.includes(uid);
  const isOwn = authorId && authorId === uid;
  const likeCount = post.likes?.length || 0;
  const commentCount = post.comments?.length || 0;

  const handleComment = async () => {
    if (!comment.trim()) return;
    setSubmitting(true);
    try {
      await onComment(pid, comment);
      setComment('');
    } finally {
      setSubmitting(false);
    }
  };

  const authorInitial = post.author?.name?.[0]?.toUpperCase() || 'U';

  return (
    <div className="post-card animate-fadeIn">
      <div className="post-header">
        <div
          onClick={() => authorId && onProfile(authorId)}
          style={{ cursor: 'pointer' }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') authorId && onProfile(authorId); }}
        >
          {post.author?.avatar
            ? <img src={mediaUrl(post.author.avatar)} className="avatar" alt="" />
            : <div className="avatar-placeholder">{authorInitial}</div>
          }
        </div>
        <div className="post-author-info" style={{ flex: 1 }}>
          <h4 onClick={() => authorId && onProfile(authorId)} style={{ cursor: authorId ? 'pointer' : 'default' }}>
            {post.author?.name}
          </h4>
          <span>
            {formatDistanceToNow(new Date(post.createdAt), { addSuffix: true })} · <Globe size={12} style={{ display: 'inline', verticalAlign: 'middle' }} />
          </span>
        </div>
        {post.author?.badges?.slice(0, 1).map(b => (
          <span key={b} className={`badge badge-${b}`}>{b}</span>
        ))}
        {isOwn && (
          <button
            type="button"
            className="btn btn-icon btn-sm"
            onClick={() => onDelete(pid)}
            title="Delete post"
            style={{ color: 'var(--text-faint)' }}
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>

      {post.content && <div className="post-content">{post.content}</div>}

      {post.media?.length > 0 && (
        <div className="post-media">
          {post.media.map((m, i) => (
            m.type === 'image'
              ? <img key={i} src={mediaUrl(m.url)} alt="Post media" />
              : <video key={i} src={mediaUrl(m.url)} controls />
          ))}
        </div>
      )}

      {(likeCount > 0 || commentCount > 0 || post.shares > 0) && (
        <div className="post-stats">
          <div className="likes-count">
            {likeCount > 0 && (
              <>
                <span className="fb-reaction-dot">
                  <ThumbsUp size={10} fill="#fff" />
                </span>
                {likeCount}
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            {commentCount > 0 && (
              <button
                type="button"
                onClick={() => setShowComments(true)}
                style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', fontSize: 15 }}
              >
                {commentCount} comment{commentCount !== 1 ? 's' : ''}
              </button>
            )}
            {(post.shares || 0) > 0 && (
              <span>{post.shares} share{(post.shares || 0) !== 1 ? 's' : ''}</span>
            )}
          </div>
        </div>
      )}

      <div className="post-actions" style={{ borderTop: '1px solid var(--border-soft)' }}>
        <button type="button" className={`action-btn ${isLiked ? 'liked' : ''}`} onClick={() => onLike(pid)}>
          <ThumbsUp size={18} fill={isLiked ? 'currentColor' : 'none'} />
          Like
        </button>
        <button type="button" className="action-btn" onClick={() => setShowComments(!showComments)}>
          <MessageCircle size={18} />
          Comment
        </button>
        <button type="button" className="action-btn" onClick={() => onShare(pid)}>
          <Share2 size={18} />
          Share
        </button>
        <button
          type="button"
          className="action-btn"
          onClick={async () => {
            try {
              await axios.post('/api/bookmarks', { type: 'post', id: pid });
              toast.success('Saved');
            } catch {
              toast.error('Could not save');
            }
          }}
        >
          <Bookmark size={18} />
          Save
        </button>
      </div>

      {showComments && (
        <div className="post-comments">
          {post.comments?.slice(-8).map((c, i) => (
            <div key={i} className="comment-item">
              <div className="avatar-placeholder" style={{ width: 32, height: 32, fontSize: 12, flexShrink: 0 }}>
                {c.author?.name?.[0]?.toUpperCase() || 'U'}
              </div>
              <div className="comment-bubble">
                <span style={{ fontWeight: 600, fontSize: 13 }}>{c.author?.name}</span>
                <p style={{ fontSize: 14, color: 'var(--text-base)', margin: '2px 0 0' }}>{c.content}</p>
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
            <div className="avatar-placeholder" style={{ width: 32, height: 32, fontSize: 12, flexShrink: 0 }}>
              {currentUser?.name?.[0]?.toUpperCase() || 'U'}
            </div>
            <input
              className="form-input"
              placeholder="Write a comment…"
              value={comment}
              onChange={e => setComment(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleComment()}
              style={{
                flex: 1, padding: '8px 14px', fontSize: 14,
                borderRadius: 18, background: 'var(--bg-base)', border: 'none'
              }}
            />
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleComment}
              disabled={submitting || !comment.trim()}
              style={{ borderRadius: 18 }}
            >
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
  const t = TRANSLATIONS[user?.language || 'en'];
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState('');
  const [media, setMedia] = useState([]);
  const [posting, setPosting] = useState(false);
  const [postsToday, setPostsToday] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [composerOpen, setComposerOpen] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [followingBusy, setFollowingBusy] = useState(null);
  const [feedInterests, setFeedInterests] = useState(user?.interests || []);
  const fileRef = useRef();

  useEffect(() => {
    fetchPosts();
    fetchSuggestions();
  }, []);

  const fetchPosts = async (p = 1) => {
    try {
      const res = await axios.get(`/api/posts?page=${p}&limit=10`);
      if (p === 1) setPosts(res.data.posts);
      else setPosts(prev => [...prev, ...res.data.posts]);
      setHasMore(p < res.data.pages);
      setPage(p);
      if (res.data.interests) setFeedInterests(res.data.interests);
    } catch {
      toast.error('Failed to load posts');
    } finally {
      setLoading(false);
    }
  };

  const fetchSuggestions = async () => {
    try {
      const res = await axios.get('/api/users/suggestions');
      setSuggestions(res.data.suggestions || []);
    } catch {
      /* ignore */
    }
  };

  const handleFollow = async (id) => {
    setFollowingBusy(id);
    try {
      await axios.post(`/api/users/follow/${id}`);
      setSuggestions(prev => prev.filter(s => (s._id || s.id) !== id));
      toast.success('Following');
      fetchPosts(1);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not follow');
    } finally {
      setFollowingBusy(null);
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
      setPostsToday(res.data.postsToday);
      setComposerOpen(false);
      toast.success('Post published');
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
        if (postIdOf(p) !== postId) return p;
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
      setPosts(prev => prev.map(p => (postIdOf(p) === postId ? { ...p, comments: res.data.comments } : p)));
    } catch { toast.error('Failed to comment'); }
  };

  const handleShare = async (postId) => {
    try {
      const res = await axios.post(`/api/posts/${postId}/share`);
      setPosts(prev => prev.map(p => (postIdOf(p) === postId ? { ...p, shares: res.data.shares } : p)));
      toast.success('Post shared');
    } catch { toast.error('Failed to share'); }
  };

  const handleDelete = async (postId) => {
    if (!confirm('Delete this post?')) return;
    try {
      await axios.delete(`/api/posts/${postId}`);
      setPosts(prev => prev.filter(p => postIdOf(p) !== postId));
      toast.success('Post deleted');
    } catch { toast.error('Failed to delete'); }
  };

  // Network = friends + follows (backend uses same rule after onboarding hubs)
  const friendCount = user?.friendCount ?? user?.friends?.length ?? 0;
  const followCount = user?.followCount ?? 0;
  const networkSize = user?.networkSize ?? (friendCount + followCount);
  const getDailyLimit = () => {
    if (networkSize === 0) return 0;
    if (networkSize === 1) return 1;
    if (networkSize < 10) return 2;
    return '∞';
  };
  const dailyLimit = getDailyLimit();
  const userId = user?._id || user?.id;
  const initials = user?.name?.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || 'U';

  return (
    <div className="page-container">
      <div className="feed-layout">
        {/* ── Left sidebar ── */}
        <aside className="sidebar-left">
          <button type="button" className="fb-side-link" onClick={() => navigate(`/profile/${userId}`)}>
            {user?.avatar
              ? <img src={mediaUrl(user.avatar)} className="avatar" style={{ width: 36, height: 36 }} alt="" />
              : <div className="avatar-placeholder" style={{ width: 36, height: 36, fontSize: 13 }}>{initials}</div>
            }
            <span style={{ fontWeight: 600 }}>{user?.name}</span>
          </button>

          <button type="button" className="fb-side-link active" onClick={() => navigate('/feed')}>
            <span className="fb-side-icon"><Home size={18} /></span>
            {t.feed || 'Home'}
          </button>
          <button type="button" className="fb-side-link" onClick={() => navigate('/qa')}>
            <span className="fb-side-icon"><HelpCircle size={18} /></span>
            {t.qa || 'Q&A'}
          </button>
          <button type="button" className="fb-side-link" onClick={() => navigate('/leaderboard')}>
            <span className="fb-side-icon gold"><Trophy size={18} /></span>
            {t.leaderboard || 'Leaderboard'}
          </button>
          <button type="button" className="fb-side-link" onClick={() => navigate('/subscriptions')}>
            <span className="fb-side-icon green"><CreditCard size={18} /></span>
            {t.subscriptions || 'Subscriptions'}
          </button>
          <button type="button" className="fb-side-link" onClick={() => navigate('/settings')}>
            <span className="fb-side-icon"><Settings size={18} /></span>
            {t.settings || 'Settings'}
          </button>
          <button type="button" className="fb-side-link" onClick={() => navigate(`/profile/${userId}`)}>
            <span className="fb-side-icon"><User size={18} /></span>
            {t.profile || 'Profile'}
          </button>

          <div style={{ height: 1, background: 'var(--border-soft)', margin: '12px 8px' }} />
          <div style={{ padding: '4px 12px', fontSize: 13, color: 'var(--text-faint)', fontWeight: 600 }}>
            Your shortcuts
          </div>
          <button type="button" className="fb-side-link" onClick={() => navigate('/ask')}>
            <span className="fb-side-icon"><HelpCircle size={18} /></span>
            Ask a question
          </button>
        </aside>

        {/* ── Center feed ── */}
        <main style={{ minWidth: 0 }}>
          {/* Interest chips */}
          {feedInterests?.length > 0 && (
            <div className="fb-widget" style={{ marginBottom: 12, padding: '12px 14px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-sub)', marginBottom: 8 }}>
                Your interests · personalized home
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {feedInterests.map(tag => (
                  <span
                    key={tag}
                    className="tag"
                    style={{ textTransform: 'capitalize', margin: 0 }}
                  >
                    {tag.replace(/-/g, ' ')}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Composer */}
          <div className="fb-composer">
            {networkSize === 0 ? (
              <div className="alert alert-warning" style={{ marginBottom: 0 }}>
                <Users size={18} />
                <div>
                  <strong>Build your network to post</strong>
                  <p style={{ margin: '4px 0 0', fontSize: 13 }}>
                    Finish onboarding interests (auto-follow hubs) or add friends / follow people in Spaces.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="fb-composer-top">
                  {user?.avatar
                    ? <img src={mediaUrl(user.avatar)} className="avatar" alt="" />
                    : <div className="avatar-placeholder">{initials}</div>
                  }
                  {composerOpen ? (
                    <textarea
                      className="form-input"
                      placeholder={`What's on your mind, ${user?.name?.split(' ')[0]}?`}
                      value={content}
                      onChange={e => setContent(e.target.value)}
                      rows={3}
                      autoFocus
                      style={{
                        flex: 1, resize: 'none', borderRadius: 12,
                        background: 'var(--bg-base)', border: 'none', fontSize: 16
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="fb-composer-input"
                      onClick={() => setComposerOpen(true)}
                    >
                      What&apos;s on your mind, {user?.name?.split(' ')[0]}?
                    </button>
                  )}
                </div>

                {composerOpen && media.length > 0 && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                    {media.map((f, i) => (
                      <div key={i} style={{ position: 'relative' }}>
                        <img
                          src={URL.createObjectURL(f)}
                          alt=""
                          style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 8 }}
                        />
                        <button
                          type="button"
                          onClick={() => setMedia(m => m.filter((_, j) => j !== i))}
                          style={{
                            position: 'absolute', top: -6, right: -6, background: '#65676B',
                            border: 'none', borderRadius: '50%', width: 22, height: 22,
                            cursor: 'pointer', color: 'white', display: 'flex',
                            alignItems: 'center', justifyContent: 'center'
                          }}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {composerOpen && (
                  <div style={{ display: 'flex', gap: 8, marginBottom: 10, justifyContent: 'flex-end' }}>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setComposerOpen(false); setContent(''); setMedia([]); }}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={handlePost}
                      disabled={posting || (!content.trim() && media.length === 0)}
                    >
                      {posting ? <div className="spinner" /> : 'Post'}
                    </button>
                  </div>
                )}

                <div className="fb-composer-divider" />
                <div className="fb-composer-actions">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*,video/*"
                    multiple
                    style={{ display: 'none' }}
                    onChange={e => {
                      setMedia(Array.from(e.target.files || []));
                      setComposerOpen(true);
                    }}
                  />
                  <button type="button" className="fb-composer-action" onClick={() => fileRef.current?.click()}>
                    <Video size={20} color="#F02849" />
                    Live video
                  </button>
                  <button type="button" className="fb-composer-action" onClick={() => fileRef.current?.click()}>
                    <Image size={20} color="#45BD62" />
                    Photo/video
                  </button>
                  <button type="button" className="fb-composer-action" onClick={() => setComposerOpen(true)}>
                    <Smile size={20} color="#F7B928" />
                    Feeling
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Posts */}
          {loading ? (
            [1, 2, 3].map(i => (
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
              <Users size={48} style={{ margin: '0 auto 16px' }} />
              <h3>No posts yet</h3>
              <p>When you and your friends share, it will show up here.</p>
            </div>
          ) : (
            <>
              {posts.map(post => (
                <PostCard
                  key={postIdOf(post)}
                  post={post}
                  currentUser={user}
                  onLike={handleLike}
                  onComment={handleComment}
                  onShare={handleShare}
                  onDelete={handleDelete}
                  onProfile={(id) => navigate(`/profile/${id}`)}
                />
              ))}
              {hasMore && (
                <button type="button" className="btn btn-secondary" style={{ width: '100%' }} onClick={() => fetchPosts(page + 1)}>
                  <ChevronDown size={16} /> See more posts
                </button>
              )}
            </>
          )}
        </main>

        {/* ── Right sidebar ── */}
        <aside className="sidebar-right">
          {/* People to follow based on interests */}
          {suggestions.length > 0 && (
            <div className="fb-widget">
              <div className="fb-widget-title">People you may like</div>
              {suggestions.slice(0, 6).map(s => {
                const sid = s._id || s.id;
                return (
                  <div
                    key={sid}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 0', borderBottom: '1px solid var(--border-soft)'
                    }}
                  >
                    <div
                      onClick={() => navigate(`/profile/${sid}`)}
                      style={{ cursor: 'pointer' }}
                    >
                      {s.avatar
                        ? <img src={mediaUrl(s.avatar)} className="avatar" style={{ width: 36, height: 36 }} alt="" />
                        : (
                          <div className="avatar-placeholder" style={{ width: 36, height: 36, fontSize: 13 }}>
                            {s.name?.[0]?.toUpperCase() || 'U'}
                          </div>
                        )}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {s.name}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {s.creatorInterest
                          ? `${s.creatorInterest} hub`
                          : (s.interests?.[0] || 'Member')}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      style={{ height: 28, fontSize: 12, padding: '0 10px' }}
                      disabled={followingBusy === sid}
                      onClick={() => handleFollow(sid)}
                    >
                      {followingBusy === sid ? '…' : 'Follow'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="fb-widget">
            <div className="fb-widget-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <BarChart2 size={16} />
              Daily post limit
            </div>
            {[
              { range: '0 network', limit: "Can't post", active: networkSize === 0 },
              { range: '1 connection', limit: '1/day', active: networkSize === 1 },
              { range: '2–9 connections', limit: '2/day', active: networkSize >= 2 && networkSize < 10 },
              { range: '10+ connections', limit: 'Unlimited', active: networkSize >= 10 }
            ].map(r => (
              <div
                key={r.range}
                style={{
                  display: 'flex', justifyContent: 'space-between', padding: '8px 8px',
                  borderRadius: 8, marginBottom: 2, fontSize: 14,
                  background: r.active ? 'var(--fb-blue-soft)' : 'transparent',
                  fontWeight: r.active ? 600 : 400
                }}
              >
                <span style={{ color: r.active ? 'var(--fb-blue)' : 'var(--text-sub)' }}>{r.range}</span>
                <span style={{ color: r.active ? 'var(--text-base)' : 'var(--text-faint)' }}>{r.limit}</span>
              </div>
            ))}
            <div style={{
              marginTop: 10, padding: 10, background: 'var(--bg-base)',
              borderRadius: 8, fontSize: 13, textAlign: 'center', color: 'var(--text-sub)'
            }}>
              Network size: <strong style={{ color: 'var(--fb-blue)' }}>{networkSize}</strong>
              {' '}({friendCount} friends · {followCount} following)
              {networkSize > 0 && (
                <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-faint)' }}>
                  {postsToday}/{dailyLimit} posts today
                </div>
              )}
            </div>
          </div>

          <div className="fb-widget">
            <div className="fb-widget-title">Sponsored</div>
            <p style={{ fontSize: 13, color: 'var(--text-faint)', lineHeight: 1.4 }}>
              Upgrade your plan for more daily questions and priority listing.
            </p>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ width: '100%', marginTop: 10 }}
              onClick={() => navigate('/subscriptions')}
            >
              See plans
            </button>
          </div>

          <div className="fb-widget">
            <div className="fb-widget-title">Contacts</div>
            <p style={{ fontSize: 13, color: 'var(--text-faint)', marginBottom: 10 }}>
              Find people and grow your network.
            </p>
            <Link to="/settings" className="fb-side-link" style={{ padding: '6px 0' }}>
              <span className="fb-side-icon"><Users size={16} /></span>
              Find friends
            </Link>
            <Link to="/leaderboard" className="fb-side-link" style={{ padding: '6px 0' }}>
              <span className="fb-side-icon gold"><Trophy size={16} /></span>
              Top contributors
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}
