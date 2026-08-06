import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import axios from '../services/api';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import {
  Image, Send, Heart, MessageCircle, Share2, Trash2, Users, X,
  Home, HelpCircle, CreditCard, Trophy, Settings, User,
  BarChart2, Globe, Bookmark, MoreHorizontal, Loader2, ArrowDown
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { TRANSLATIONS } from '../i18n/translations';
import {
  Avatar, EmptyState, ErrorState, IconButton, PostMedia,
  Sheet, SkeletonList, SkeletonPostCard
} from '../components/ui';
import { useOptimisticList } from '../hooks/useOptimistic';
import useInfiniteScroll from '../hooks/useInfiniteScroll';
import usePullToRefresh from '../hooks/usePullToRefresh';
import { playLike } from '../utils/sound';
import { uploadPostMedia, PresignUnavailableError } from '../services/uploads';
import useReducedMotion from '../hooks/useReducedMotion';

const MAX_MEDIA = 5;
const MAX_FILE_MB = 50;

function postIdOf(post) {
  return post?._id || post?.id;
}

function haptic(ms = 8) {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    try { navigator.vibrate(ms); } catch { /* unsupported */ }
  }
}

function PostCard({ post, currentUser, onLike, onComment, onShare, onDelete, onSave, onProfile, index }) {
  const [showComments, setShowComments] = useState(false);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [bump, setBump] = useState(0);
  const reduced = useReducedMotion();

  const uid = currentUser?._id || currentUser?.id;
  const authorId = post.author?._id || post.author?.id;
  const pid = postIdOf(post);
  const isLiked = post.likes?.includes(uid);
  const isOwn = authorId && authorId === uid;
  const likeCount = post.likes?.length || 0;
  const commentCount = post.comments?.length || 0;

  const handleComment = async () => {
    const body = comment.trim();
    if (!body) return;
    setSubmitting(true);
    // Clear immediately — the optimistic comment is already in the list
    setComment('');
    try {
      await onComment(pid, body);
    } finally {
      setSubmitting(false);
    }
  };

  /*
   * The like tap fires three things before the network call: a vibration, a
   * sound, and a bump counter that drives the button's hop.
   *
   * `isLiked` is read here rather than inside the handler chain because the
   * optimistic update in Feed flips it immediately — by the time onLike
   * resolves, the value has already changed, and the sound would be the wrong
   * one. Bumping a counter rather than toggling a boolean means a rapid
   * double-tap replays the animation instead of cancelling it.
   */
  const like = useCallback(() => {
    haptic();
    playLike(!isLiked);
    setBump((n) => n + 1);
    onLike(pid);
  }, [onLike, pid, isLiked]);

  return (
    <motion.article
      className="post-card"
      initial={reduced ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        reduced
          ? { duration: 0 }
          : // Stagger only the first screenful; later pages appear immediately
            { duration: 0.32, ease: [0.16, 1, 0.3, 1], delay: Math.min(index, 4) * 0.04 }
      }
    >
      <div className="post-header">
        <button
          type="button"
          onClick={() => authorId && onProfile(authorId)}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
          aria-label={`View ${post.author?.name}'s profile`}
        >
          <Avatar src={post.author?.avatar} name={post.author?.name} size={40} />
        </button>

        <div className="post-author-info" style={{ flex: 1, minWidth: 0 }}>
          <h4
            onClick={() => authorId && onProfile(authorId)}
            style={{ cursor: authorId ? 'pointer' : 'default' }}
          >
            {post.author?.name}
          </h4>
          <span>
            {formatDistanceToNow(new Date(post.createdAt), { addSuffix: true })}
            {' · '}
            <Globe size={12} style={{ display: 'inline', verticalAlign: 'middle' }} />
          </span>
        </div>

        {post.author?.badges?.slice(0, 1).map((b) => (
          <span key={b} className={`badge badge-${b}`}>{b}</span>
        ))}

        {isOwn && (
          <IconButton
            icon={MoreHorizontal}
            label="Post options"
            small
            onClick={() => setMenuOpen(true)}
          />
        )}
      </div>

      {post.content && <div className="post-content">{post.content}</div>}

      {post.media?.length > 0 && (
        <PostMedia media={post.media} onDoubleTapLike={!isLiked ? like : undefined} />
      )}

      {(likeCount > 0 || commentCount > 0 || post.shares > 0) && (
        <div className="post-stats">
          <div className="likes-count">
            {likeCount > 0 && (
              <>
                <span className="reaction-dot" style={{ background: 'var(--red)' }}>
                  <Heart size={10} fill="currentColor" strokeWidth={0} />
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
                style={{
                  background: 'none', border: 'none', color: 'var(--text-faint)',
                  cursor: 'pointer', fontSize: 'var(--fs-base)'
                }}
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
        <motion.button
          type="button"
          className={`action-btn action-btn-like ${isLiked ? 'liked' : ''}`}
          onClick={like}
          aria-pressed={isLiked}
          // Pressing anywhere on the button dips the whole thing, so the tap
          // registers visually even on the padding rather than only on the icon.
          whileTap={reduced ? undefined : { scale: 0.94 }}
          animate={
            reduced || bump === 0
              ? { y: 0 }
              : // Keyed on the counter so a rapid double-tap replays the hop
                // instead of the second tap cancelling the first.
                { y: [0, -9, 0, -3, 0] }
          }
          transition={reduced ? { duration: 0 } : { duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
          key={`like-${bump}`}
        >
          <motion.span
            className="action-icon"
            initial={false}
            animate={{ scale: isLiked ? 1.12 : 1, rotate: isLiked ? [0, -14, 10, 0] : 0 }}
            transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 600, damping: 16 }}
          >
            <Heart size={18} fill={isLiked ? 'currentColor' : 'none'} strokeWidth={isLiked ? 0 : 2} />
          </motion.span>
          Like
        </motion.button>

        <button type="button" className="action-btn" onClick={() => setShowComments((v) => !v)}>
          <span className="action-icon"><MessageCircle size={18} /></span>
          Comment
        </button>

        <button type="button" className="action-btn" onClick={() => { haptic(); onShare(pid); }}>
          <span className="action-icon"><Share2 size={18} /></span>
          Share
        </button>

        <button
          type="button"
          className={`action-btn ${post.saved ? 'saved' : ''}`}
          onClick={() => { haptic(); onSave(pid, !post.saved); }}
          aria-pressed={!!post.saved}
        >
          <span className="action-icon">
            <Bookmark size={18} fill={post.saved ? 'currentColor' : 'none'} strokeWidth={post.saved ? 0 : 2} />
          </span>
          {post.saved ? 'Saved' : 'Save'}
        </button>
      </div>

      <AnimatePresence initial={false}>
        {showComments && (
          <motion.div
            className="post-comments"
            initial={reduced ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.22, ease: [0.16, 1, 0.3, 1] }}
            style={{ overflow: 'hidden' }}
          >
            {post.comments?.slice(-8).map((c, i) => (
              <div key={c._id || c.id || `pending-${i}`} className="comment-item">
                <Avatar src={c.author?.avatar} name={c.author?.name} size={32} />
                <div className="comment-bubble" style={{ opacity: c.pending ? 0.55 : 1 }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{c.author?.name}</span>
                  <p style={{ fontSize: 14, color: 'var(--text-base)', margin: '2px 0 0' }}>{c.content}</p>
                </div>
              </div>
            ))}

            <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
              <Avatar src={currentUser?.avatar} name={currentUser?.name} size={32} />
              <input
                className="form-input"
                placeholder="Write a comment…"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => {
                  // Shift+Enter should not submit
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleComment();
                  }
                }}
                style={{
                  flex: 1, padding: '8px 14px', fontSize: 14,
                  borderRadius: 'var(--r-pill)', background: 'var(--bg-raised)', border: 'none'
                }}
              />
              <IconButton
                icon={Send}
                label="Send comment"
                size={16}
                onClick={handleComment}
                disabled={submitting || !comment.trim()}
                variant="filled"
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Replaces the native confirm() this used to call */}
      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title="Post options">
        <button
          type="button"
          className="dropdown-item danger"
          onClick={() => {
            setMenuOpen(false);
            onDelete(pid);
          }}
        >
          <Trash2 size={18} />
          Delete post
        </button>
      </Sheet>
    </motion.article>
  );
}

export default function Feed() {
  const { user, refreshUser } = useAuth();
  const navigate = useNavigate();
  const t = TRANSLATIONS[user?.language || 'en'];

  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [content, setContent] = useState('');
  const [media, setMedia] = useState([]);
  const [posting, setPosting] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [postsToday, setPostsToday] = useState(0);
  const [nextCursor, setNextCursor] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [composerOpen, setComposerOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [followingBusy, setFollowingBusy] = useState(null);
  const [feedInterests, setFeedInterests] = useState(user?.interests || []);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const fileRef = useRef();

  const { run } = useOptimisticList(setPosts);
  const uid = user?._id || user?.id;

  /* ── data ─────────────────────────────────────────────── */

  /**
   * Cursor (keyset) pagination.
   *
   * The API used to take ?page=N, rank a 60-row window server-side and slice
   * it — which capped the feed at 60 posts and could show or skip a post as the
   * window shifted. It now returns an opaque `nextCursor`; passing it back asks
   * for rows strictly older than the last one we hold, so the sequence is
   * stable no matter what gets posted while you scroll.
   */
  const fetchPosts = useCallback(async (cursor = null) => {
    if (!cursor) setLoadError(false);
    else setLoadingMore(true);
    try {
      const res = await axios.get('/api/posts', {
        params: { limit: 10, ...(cursor ? { cursor } : {}) }
      });
      const incoming = res.data.posts || [];
      setPosts((prev) => {
        if (!cursor) return incoming;
        // Belt and braces against an observer double-fire
        const seen = new Set(prev.map(postIdOf));
        return [...prev, ...incoming.filter((x) => !seen.has(postIdOf(x)))];
      });
      setNextCursor(res.data.nextCursor || null);
      setHasMore(!!res.data.hasMore);
      if (res.data.interests) setFeedInterests(res.data.interests);
    } catch {
      if (!cursor) setLoadError(true);
      else toast.error('Could not load more posts');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  const fetchSuggestions = useCallback(async () => {
    try {
      const res = await axios.get('/api/users/suggestions');
      setSuggestions(res.data.suggestions || []);
    } catch {
      /* a missing suggestion rail is not worth interrupting the feed */
    }
  }, []);

  /**
   * The Save button had no persisted state — it never showed whether a post was
   * already bookmarked. There is no lightweight "my bookmark ids" endpoint, so
   * we reuse GET /api/bookmarks once, off the critical path, and mark the feed.
   */
  const fetchSavedIds = useCallback(async () => {
    try {
      const res = await axios.get('/api/bookmarks');
      const savedIds = new Set(
        (res.data.bookmarks || []).filter((b) => b.type === 'post').map((b) => b.id)
      );
      if (savedIds.size) {
        setPosts((prev) => prev.map((p) => (savedIds.has(postIdOf(p)) ? { ...p, saved: true } : p)));
      }
    } catch {
      /* leaving Save unfilled is better than blocking the feed */
    }
  }, []);

  useEffect(() => {
    fetchPosts().then(fetchSavedIds);
    fetchSuggestions();
  }, [fetchPosts, fetchSuggestions, fetchSavedIds]);

  const refresh = useCallback(async () => {
    await Promise.all([fetchPosts(), fetchSuggestions()]);
  }, [fetchPosts, fetchSuggestions]);

  const { pull, refreshing, ready } = usePullToRefresh(refresh);

  const sentinelRef = useInfiniteScroll({
    hasMore,
    loading: loading || loadingMore,
    onLoadMore: () => fetchPosts(nextCursor)
  });

  /* ── mutations (optimistic) ───────────────────────────── */

  const handleLike = useCallback(
    (postId) => {
      const current = posts.find((p) => postIdOf(p) === postId);
      if (!current) return;
      const liked = current.likes?.includes(uid);

      run({
        id: postId,
        optimistic: (p) => ({
          likes: liked
            ? (p.likes || []).filter((id) => id !== uid)
            : [...(p.likes || []), uid]
        }),
        request: () => axios.post(`/api/posts/${postId}/like`),
        commit: (res) => (prev) => ({
          likes: res.data.liked
            ? [...new Set([...(prev.likes || []), uid])]
            : (prev.likes || []).filter((id) => id !== uid)
        }),
        onError: () => toast.error('Could not update your like')
      });
    },
    [posts, run, uid]
  );

  const handleComment = useCallback(
    async (postId, body) => {
      const optimisticComment = {
        _id: `pending-${Date.now()}`,
        content: body,
        author: { _id: uid, name: user?.name, avatar: user?.avatar },
        createdAt: new Date().toISOString(),
        pending: true
      };

      await run({
        id: postId,
        dedupe: false,
        optimistic: (p) => ({ comments: [...(p.comments || []), optimisticComment] }),
        request: () => axios.post(`/api/posts/${postId}/comment`, { content: body }),
        commit: (res) => ({ comments: res.data.comments }),
        onError: () => toast.error('Comment failed to send')
      });
    },
    [run, uid, user?.avatar, user?.name]
  );

  const handleShare = useCallback(
    (postId) => {
      run({
        id: postId,
        optimistic: (p) => ({ shares: (p.shares || 0) + 1 }),
        request: () => axios.post(`/api/posts/${postId}/share`),
        commit: (res) => ({ shares: res.data.shares }),
        onError: () => toast.error('Could not share')
      });
    },
    [run]
  );

  const handleSave = useCallback(
    (postId, next) => {
      run({
        id: postId,
        optimistic: { saved: next },
        request: () =>
          next
            ? axios.post('/api/bookmarks', { type: 'post', id: postId })
            // DELETE /api/bookmarks takes the target in the body, not the path
            : axios.delete('/api/bookmarks', { data: { type: 'post', id: postId } }),
        onError: () => toast.error(next ? 'Could not save' : 'Could not remove')
      });
    },
    [run]
  );

  const confirmDelete = useCallback(async () => {
    const postId = confirmDeleteId;
    setConfirmDeleteId(null);
    if (!postId) return;

    const snapshot = posts;
    setPosts((prev) => prev.filter((p) => postIdOf(p) !== postId));
    try {
      await axios.delete(`/api/posts/${postId}`);
      toast.success('Post deleted');
    } catch {
      setPosts(snapshot);
      toast.error('Could not delete that post');
    }
  }, [confirmDeleteId, posts]);

  const handleFollow = useCallback(
    async (id) => {
      setFollowingBusy(id);
      try {
        await axios.post(`/api/users/follow/${id}`);
        setSuggestions((prev) => prev.filter((s) => (s._id || s.id) !== id));
        toast.success('Following');
        // Refresh the derived counts without discarding the feed or scroll position
        refreshUser();
      } catch (err) {
        toast.error(err.response?.data?.message || 'Could not follow');
      } finally {
        setFollowingBusy(null);
      }
    },
    [refreshUser]
  );

  /* ── composer ─────────────────────────────────────────── */

  // Object URLs must be revoked or every re-render leaks one
  const previews = useMemo(
    () => media.map((f) => ({ file: f, url: URL.createObjectURL(f) })),
    [media]
  );
  useEffect(() => () => previews.forEach((p) => URL.revokeObjectURL(p.url)), [previews]);

  const addFiles = useCallback(
    (incoming) => {
      const files = Array.from(incoming || []);
      if (!files.length) return;

      const accepted = [];
      for (const f of files) {
        if (!/^(image|video)\//.test(f.type)) {
          toast.error(`${f.name} is not an image or video`);
          continue;
        }
        if (f.size > MAX_FILE_MB * 1024 * 1024) {
          toast.error(`${f.name} is over ${MAX_FILE_MB}MB`);
          continue;
        }
        accepted.push(f);
      }

      setMedia((prev) => {
        // Append rather than replace — picking twice used to discard the first set
        const next = [...prev, ...accepted];
        if (next.length > MAX_MEDIA) {
          toast.error(`Up to ${MAX_MEDIA} files per post`);
          return next.slice(0, MAX_MEDIA);
        }
        return next;
      });
      setComposerOpen(true);
    },
    []
  );

  const handlePost = async () => {
    if (!content.trim() && media.length === 0) return;
    setPosting(true);
    setUploadPct(0);
    try {
      let res;

      /*
       * Upload each file straight to storage first, then post only the keys.
       *
       * Multipart went through the API, and a serverless request body is capped
       * near 4.5MB — so the 50MB this composer advertises used to fail on any
       * real photo, with nothing useful to show for it. Images are also
       * downscaled in the browser on the way, so a 12MB photo uploads as ~200KB.
       *
       * Progress is averaged across the files rather than shown per file: the
       * bar is one bar, and a per-file reset reads as the upload restarting.
       */
      let keys = [];
      if (media.length) {
        const pct = new Array(media.length).fill(0);
        const report = () =>
          setUploadPct(Math.round(pct.reduce((a, b) => a + b, 0) / media.length));

        keys = await Promise.all(
          media.map((file, i) =>
            uploadPostMedia(file, {
              onProgress: (p) => { pct[i] = p; report(); }
            })
          )
        );
      }

      res = await axios.post('/api/posts', {
        content: content || undefined,
        mediaKeys: keys
      });

      setPosts((prev) => [res.data.post, ...prev]);
      setContent('');
      setMedia([]);
      setPostsToday(res.data.postsToday);
      setComposerOpen(false);
      haptic(12);
      toast.success('Post published');
      refreshUser();
    } catch (err) {
      /*
       * A deployment with no storage configured answers presign with 503. That
       * is not a failure the user can act on, so fall back to the old multipart
       * post — it still works for anything small enough to fit through the
       * function, which is what such a deployment was limited to anyway.
       */
      if (err instanceof PresignUnavailableError) {
        try {
          const formData = new FormData();
          if (content) formData.append('content', content);
          media.forEach((f) => formData.append('media', f));

          const res = await axios.post('/api/posts', formData, {
            onUploadProgress: (e) => {
              if (e.total) setUploadPct(Math.round((e.loaded / e.total) * 100));
            }
          });

          setPosts((prev) => [res.data.post, ...prev]);
          setContent('');
          setMedia([]);
          setPostsToday(res.data.postsToday);
          setComposerOpen(false);
          haptic(12);
          toast.success('Post published');
          refreshUser();
          return;
        } catch (fallbackErr) {
          toast.error(fallbackErr.response?.data?.message || 'Failed to post');
          return;
        }
      }
      toast.error(err.response?.data?.message || err.message || 'Failed to post');
    } finally {
      setPosting(false);
      setUploadPct(0);
    }
  };

  // Paste an image straight into the composer
  useEffect(() => {
    if (!composerOpen) return undefined;
    const onPaste = (e) => {
      const files = Array.from(e.clipboardData?.files || []);
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [composerOpen, addFiles]);

  /* ── derived ──────────────────────────────────────────── */

  const friendCount = user?.friendCount ?? user?.friends?.length ?? 0;
  const followCount = user?.followCount ?? 0;
  const networkSize = user?.networkSize ?? (friendCount + followCount);
  const dailyLimit =
    networkSize === 0 ? 0 : networkSize === 1 ? 1 : networkSize < 10 ? 2 : '∞';
  const userId = uid;

  return (
    <div className="page-container ptr-host">
      {/* Pull-to-refresh affordance (touch only) */}
      {pull > 0 && (
        <motion.div
          className="ptr-indicator"
          style={{ x: '-50%' }}
          animate={{ y: pull, rotate: refreshing ? 360 : ready ? 180 : 0 }}
          transition={
            refreshing
              ? { rotate: { repeat: Infinity, duration: 0.8, ease: 'linear' } }
              : { type: 'spring', stiffness: 400, damping: 30 }
          }
        >
          {refreshing ? <Loader2 size={18} /> : <ArrowDown size={18} />}
        </motion.div>
      )}

      <div className="feed-layout">
        {/* ── Left sidebar ── */}
        <aside className="sidebar-left">
          <button type="button" className="side-link" onClick={() => navigate(`/profile/${userId}`)}>
            <Avatar src={user?.avatar} name={user?.name} size={36} />
            <span style={{ fontWeight: 600 }}>{user?.name}</span>
          </button>

          <button type="button" className="side-link active" onClick={() => navigate('/feed')}>
            <span className="side-icon"><Home size={18} /></span>
            {t.feed || 'Home'}
          </button>
          <button type="button" className="side-link" onClick={() => navigate('/qa')}>
            <span className="side-icon"><HelpCircle size={18} /></span>
            {t.qa || 'Q&A'}
          </button>
          <button type="button" className="side-link" onClick={() => navigate('/leaderboard')}>
            <span className="side-icon gold"><Trophy size={18} /></span>
            {t.leaderboard || 'Leaderboard'}
          </button>
          <button type="button" className="side-link" onClick={() => navigate('/subscriptions')}>
            <span className="side-icon green"><CreditCard size={18} /></span>
            {t.subscriptions || 'Subscriptions'}
          </button>
          <button type="button" className="side-link" onClick={() => navigate('/settings')}>
            <span className="side-icon"><Settings size={18} /></span>
            {t.settings || 'Settings'}
          </button>
          <button type="button" className="side-link" onClick={() => navigate(`/profile/${userId}`)}>
            <span className="side-icon"><User size={18} /></span>
            {t.profile || 'Profile'}
          </button>

          <div style={{ height: 1, background: 'var(--border-soft)', margin: '12px 8px' }} />
          <div style={{ padding: '4px 12px', fontSize: 13, color: 'var(--text-faint)', fontWeight: 600 }}>
            Your shortcuts
          </div>
          <button type="button" className="side-link" onClick={() => navigate('/ask')}>
            <span className="side-icon"><HelpCircle size={18} /></span>
            Ask a question
          </button>
        </aside>

        {/* ── Center feed ── */}
        <main style={{ minWidth: 0 }}>
          {feedInterests?.length > 0 && (
            <div className="widget" style={{ marginBottom: 12, padding: '12px 14px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-sub)', marginBottom: 8 }}>
                Your interests · personalized home
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {feedInterests.map((tag) => (
                  <span key={tag} className="tag" style={{ textTransform: 'capitalize', margin: 0 }}>
                    {tag.replace(/-/g, ' ')}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Composer */}
          <div
            className={`composer composer-dropzone ${dragging ? 'is-dragging' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              addFiles(e.dataTransfer?.files);
            }}
          >
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
                <div className="composer-top">
                  <Avatar src={user?.avatar} name={user?.name} size={40} />
                  {composerOpen ? (
                    <textarea
                      className="form-input"
                      placeholder={`What's on your mind, ${user?.name?.split(' ')[0]}?`}
                      value={content}
                      onChange={(e) => setContent(e.target.value)}
                      rows={3}
                      autoFocus
                      style={{
                        flex: 1, resize: 'none', borderRadius: 'var(--r-lg)',
                        background: 'var(--bg-raised)', border: 'none', fontSize: 16
                      }}
                    />
                  ) : (
                    <button type="button" className="composer-input" onClick={() => setComposerOpen(true)}>
                      What&apos;s on your mind, {user?.name?.split(' ')[0]}?
                    </button>
                  )}
                </div>

                {composerOpen && previews.length > 0 && (
                  <div className="composer-thumbs">
                    {previews.map((p, i) => (
                      <div key={p.url} className="composer-thumb">
                        {/* Videos used to render through <img> and showed as broken tiles */}
                        {p.file.type.startsWith('video/') ? (
                          <>
                            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                            <video src={p.url} muted playsInline preload="metadata" />
                            <span className="composer-thumb-badge">Video</span>
                          </>
                        ) : (
                          <img src={p.url} alt={p.file.name} />
                        )}
                        <button
                          type="button"
                          className="composer-thumb-remove"
                          aria-label={`Remove ${p.file.name}`}
                          onClick={() => setMedia((m) => m.filter((_, j) => j !== i))}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {posting && uploadPct > 0 && (
                  <div className="upload-progress" aria-label={`Uploading ${uploadPct}%`}>
                    <div className="upload-progress-bar" style={{ width: `${uploadPct}%` }} />
                  </div>
                )}

                {composerOpen && (
                  <div style={{ display: 'flex', gap: 8, margin: '10px 0', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => { setComposerOpen(false); setContent(''); setMedia([]); }}
                    >
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

                <div className="composer-divider" />
                <div className="composer-actions">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*,video/*"
                    multiple
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      addFiles(e.target.files);
                      // Reset so picking the same file twice still fires onChange
                      e.target.value = '';
                    }}
                  />
                  <button
                    type="button"
                    className="composer-action"
                    onClick={() => fileRef.current?.click()}
                    disabled={media.length >= MAX_MEDIA}
                  >
                    <Image size={20} style={{ color: 'var(--green)' }} />
                    Photo / video
                  </button>
                  <button
                    type="button"
                    className="composer-action"
                    onClick={() => setComposerOpen(true)}
                  >
                    <MessageCircle size={20} style={{ color: 'var(--nx-violet)' }} />
                    Write something
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Posts */}
          {loading ? (
            <SkeletonList count={3} Item={SkeletonPostCard} />
          ) : loadError ? (
            <ErrorState
              title="Could not load your feed"
              description="We could not reach Nexora just now. Check your connection and try again."
              onRetry={() => { setLoading(true); fetchPosts(); }}
            />
          ) : posts.length === 0 ? (
            <EmptyState
              icon={Users}
              title="Your feed is quiet"
              description="Follow a few interest hubs or add friends, and their posts will land here."
              action={
                <button type="button" className="btn btn-primary" onClick={() => navigate('/spaces')}>
                  Explore Spaces
                </button>
              }
            />
          ) : (
            <>
              <AnimatePresence initial={false}>
                {posts.map((post, i) => (
                  <PostCard
                    key={postIdOf(post)}
                    index={i}
                    post={post}
                    currentUser={user}
                    onLike={handleLike}
                    onComment={handleComment}
                    onShare={handleShare}
                    onSave={handleSave}
                    onDelete={setConfirmDeleteId}
                    onProfile={(id) => navigate(`/profile/${id}`)}
                  />
                ))}
              </AnimatePresence>

              {/* Auto-loads as it approaches the viewport */}
              <div ref={sentinelRef} className="feed-sentinel" />

              {loadingMore && <SkeletonPostCard withMedia={false} />}

              {!hasMore && posts.length > 4 && (
                <p style={{
                  textAlign: 'center', color: 'var(--text-faint)',
                  fontSize: 'var(--fs-sm)', padding: 'var(--space-6) 0'
                }}>
                  You are all caught up
                </p>
              )}
            </>
          )}
        </main>

        {/* ── Right sidebar ── */}
        <aside className="sidebar-right">
          {suggestions.length > 0 && (
            <div className="widget">
              <div className="widget-title">People you may like</div>
              {suggestions.slice(0, 6).map((s) => {
                const sid = s._id || s.id;
                return (
                  <div
                    key={sid}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 0', borderBottom: '1px solid var(--border-soft)'
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => navigate(`/profile/${sid}`)}
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                      aria-label={`View ${s.name}'s profile`}
                    >
                      <Avatar src={s.avatar} name={s.name} size={36} />
                    </button>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap',
                        overflow: 'hidden', textOverflow: 'ellipsis'
                      }}>
                        {s.name}
                      </div>
                      <div style={{
                        fontSize: 12, color: 'var(--text-faint)', whiteSpace: 'nowrap',
                        overflow: 'hidden', textOverflow: 'ellipsis'
                      }}>
                        {s.creatorInterest ? `${s.creatorInterest} hub` : (s.interests?.[0] || 'Member')}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      style={{ height: 30, fontSize: 12, padding: '0 12px' }}
                      disabled={followingBusy === sid}
                      onClick={() => handleFollow(sid)}
                    >
                      {followingBusy === sid ? <div className="spinner" style={{ width: 12, height: 12 }} /> : 'Follow'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="widget">
            <div className="widget-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <BarChart2 size={16} />
              Daily post limit
            </div>
            {[
              { range: '0 network', limit: "Can't post", active: networkSize === 0 },
              { range: '1 connection', limit: '1/day', active: networkSize === 1 },
              { range: '2–9 connections', limit: '2/day', active: networkSize >= 2 && networkSize < 10 },
              { range: '10+ connections', limit: 'Unlimited', active: networkSize >= 10 }
            ].map((r) => (
              <div
                key={r.range}
                style={{
                  display: 'flex', justifyContent: 'space-between', padding: '8px',
                  borderRadius: 'var(--r-sm)', marginBottom: 2, fontSize: 14,
                  background: r.active ? 'var(--nx-violet-soft)' : 'transparent',
                  fontWeight: r.active ? 600 : 400
                }}
              >
                <span style={{ color: r.active ? 'var(--nx-violet)' : 'var(--text-sub)' }}>{r.range}</span>
                <span style={{ color: r.active ? 'var(--text-base)' : 'var(--text-faint)' }}>{r.limit}</span>
              </div>
            ))}
            <div style={{
              marginTop: 10, padding: 10, background: 'var(--bg-raised)',
              borderRadius: 'var(--r-sm)', fontSize: 13, textAlign: 'center', color: 'var(--text-sub)'
            }}>
              Network size: <strong style={{ color: 'var(--nx-violet)' }}>{networkSize}</strong>
              {' '}({friendCount} friends · {followCount} following)
              {networkSize > 0 && (
                <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-faint)' }}>
                  {postsToday}/{dailyLimit} posts today
                </div>
              )}
            </div>
          </div>

          <div className="widget">
            <div className="widget-title">Go further</div>
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

          <div className="widget">
            <div className="widget-title">Contacts</div>
            <p style={{ fontSize: 13, color: 'var(--text-faint)', marginBottom: 10 }}>
              Find people and grow your network.
            </p>
            <Link to="/settings" className="side-link" style={{ padding: '6px 0' }}>
              <span className="side-icon"><Users size={16} /></span>
              Find friends
            </Link>
            <Link to="/leaderboard" className="side-link" style={{ padding: '6px 0' }}>
              <span className="side-icon gold"><Trophy size={16} /></span>
              Top contributors
            </Link>
          </div>
        </aside>
      </div>

      <Sheet
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        title="Delete this post?"
      >
        <p style={{ color: 'var(--text-sub)', marginBottom: 'var(--space-5)' }}>
          This cannot be undone. The post and its comments will be removed for everyone.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={() => setConfirmDeleteId(null)}>
            Keep it
          </button>
          <button type="button" className="btn btn-danger" onClick={confirmDelete}>
            <Trash2 size={16} />
            Delete
          </button>
        </div>
      </Sheet>
    </div>
  );
}
