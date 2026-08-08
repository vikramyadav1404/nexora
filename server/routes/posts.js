const express = require('express');
const router = express.Router();
const multer = require('multer');
const { getSupabase } = require('../db/supabase');
const {
  isToday, getDailyPostLimit, shapeAuthor, withMediaColumns,
  loadPostBundles, loadPostBundle
} = require('../db/helpers');
const { protect } = require('../middleware/auth');
const { claimDailyQuota } = require('../utils/quota');
const { touchUserActivity, pushNotification } = require('../db/features');
const { uploadMedia } = require('../utils/storage');
const { optimizeImage } = require('../utils/image');
const { writeLimiter } = require('../middleware/rateLimit');
const { sanitizeText } = require('../utils/validate');
const { sendError, asyncHandler } = require('../utils/respond');
const { verifyPostUpload } = require('../utils/postMedia');
const { MediaError } = require('../utils/profileMedia');

const MAX_MEDIA_PER_POST = 5;

/*
 * The multipart fallback, kept for browsers still running an older bundle.
 *
 * The 50MB here is not the real ceiling on this path and never was: the request
 * has to fit inside a serverless function body, which Vercel caps near 4.5MB,
 * so anything larger is rejected at the edge before multer sees it. Files that
 * size now arrive as keys via /api/uploads/presign instead, where 50MB is
 * enforced against the stored object and is achievable.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// Warn once, not once per request, if migration 006 hasn't been run.
let feedRpcWarned = false;
// Same, for migration 011.
let storageKeyWarned = false;

/** Opaque cursor so clients don't build their own keyset tuples. */
function encodeCursor(post) {
  if (!post) return null;
  return Buffer.from(`${post.created_at}|${post.id}`).toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return { ts: null, id: null };
  try {
    const [ts, id] = Buffer.from(String(cursor), 'base64url').toString('utf8').split('|');
    return ts && id ? { ts, id } : { ts: null, id: null };
  } catch {
    return { ts: null, id: null };
  }
}

// GET /api/posts — personalized by interests + follows when available
router.get('/', protect, asyncHandler(async (req, res) => {
  const db = getSupabase();
  const interests = req.userRow.interests || [];
  const personalized = req.query.personalized !== '0';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
  const { ts, id } = decodeCursor(req.query.cursor);

  /*
   * Ranking and paging both happen in SQL now.
   *
   * The previous implementation fetched a 60-row window, sorted it in JS and
   * sliced a page out. That capped the feed at 60 posts, and because the
   * window size changed with the page number the sort order changed too —
   * so infinite scroll could show a post twice or skip it entirely.
   */
  let rows;
  const { data, error } = await db.rpc('feed_for_user', {
    p_user_id: req.user.id,
    p_cursor_ts: ts,
    p_cursor_id: id,
    p_limit: limit + 1, // one extra row tells us whether more exist
    p_personalized: personalized
  });

  if (error) {
    // The RPC ships in migration 006; fall back to plain recency so an
    // un-migrated database still serves a (correct, unranked) feed.
    if (!feedRpcWarned) {
      feedRpcWarned = true;
      console.warn(
        `feed_for_user unavailable (${error.message}); serving unranked feed. ` +
        'Run server/db/migrations/006_feed.sql to enable ranking.'
      );
    }
    let q = db.from('posts').select('*').eq('is_public', true);
    if (ts) q = q.lt('created_at', ts);
    const fallback = await q.order('created_at', { ascending: false }).limit(limit + 1);
    if (fallback.error) throw fallback.error;
    rows = fallback.data || [];
  } else {
    rows = data || [];
  }

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const posts = await loadPostBundles(db, pageRows);

  res.json({
    posts,
    // Opaque keyset cursor — pass it back as ?cursor= for the next page.
    nextCursor: hasMore ? encodeCursor(pageRows[pageRows.length - 1]) : null,
    hasMore,
    personalized: personalized && interests.length > 0,
    interests
  });
}, "Could not load the feed"));

// POST /api/posts
router.post('/', protect, writeLimiter, upload.array('media', 5), async (req, res) => {
  try {
    const db = getSupabase();
    const userId = req.user.id;

    // Network size = friends + accounts you follow (after onboarding interest hubs count)
    const [{ count: friendCount }, { count: followCount }] = await Promise.all([
      db.from('friendships').select('*', { count: 'exact', head: true }).eq('user_id', userId),
      db.from('follows').select('*', { count: 'exact', head: true }).eq('follower_id', userId)
    ]);
    const networkSize = (friendCount || 0) + (followCount || 0);

    const postLimit = getDailyPostLimit(networkSize);
    if (postLimit === 0) {
      return res.status(403).json({
        message: 'Follow interest accounts or add friends to post. Finish onboarding or open Spaces → Follow hubs.'
      });
    }

    const content = sanitizeText(req.body.content, 5000);
    const mediaFiles = [];

    /*
     * Two ways media can arrive.
     *
     * mediaKeys: the browser already PUT the bytes to storage using a ticket
     * from /api/uploads/presign, and sends only the object keys. This is the
     * path that works for real files — multipart has to fit inside a serverless
     * request body, which Vercel caps near 4.5MB, so the 50MB the composer
     * advertises was never achievable through it.
     *
     * req.files: the original multipart path, kept because browsers already
     * running an older bundle still post this way. Removing it would break them
     * mid-session for no gain.
     */
    const mediaKeys = Array.isArray(req.body?.mediaKeys) ? req.body.mediaKeys : [];

    if (mediaKeys.length > MAX_MEDIA_PER_POST) {
      return res.status(400).json({ message: `Up to ${MAX_MEDIA_PER_POST} files per post` });
    }

    for (const key of mediaKeys) {
      // Throws MediaError with its own status: 403 for someone else's key, 404
      // when nothing was uploaded, 413 oversized, 400 when the bytes are not
      // actually the media type the key claims.
      const verified = await verifyPostUpload({ key: String(key), userId });
      mediaFiles.push({
        type: verified.type,
        url: verified.url,
        storage_key: verified.key
      });
    }

    if (req.files?.length) {
      for (const f of req.files) {
        // Resize + WebP before storage. A phone photo is often 4-12MB; feed
        // images never render wider than ~640px, so this is a ~95% saving.
        // The presign path does this in the browser instead, before the PUT.
        const { file: ready, optimized, before, after, saved } = await optimizeImage(f, { kind: 'post' });
        if (optimized) {
          console.log('[image] ' + Math.round(before/1024) + 'KB -> ' + Math.round(after/1024) + 'KB (' + saved + '% smaller)');
        }
        const up = await uploadMedia(ready, { bucket: 'posts', folder: userId });
        mediaFiles.push({
          type: (ready.mimetype || '').startsWith('image') ? 'image' : 'video',
          url: up.url,
          // Nothing to record: uploadMedia returns a public URL, and the old
          // path never kept the object path. Migration 011 documents why these
          // rows keep an empty key.
          storage_key: ''
        });
      }
    }

    if (!content && mediaFiles.length === 0) {
      return res.status(400).json({ message: 'Post must have content or media' });
    }

    /*
     * The quota is claimed here: after every validation, immediately before the
     * row is created.
     *
     * Atomicity is what matters, not earliness. The old code read
     * req.userRow.posts_today, checked it, and wrote it back at the end of the
     * request, so two concurrent posts both saw the same stale count and both
     * passed. claimDailyQuota takes a row lock, so only one caller can take the
     * last slot.
     *
     * Claiming any earlier would charge a slot for requests that then fail
     * validation -- a rejected upload or an empty post would silently cost
     * someone their only post of the day. A test caught exactly that.
     */
    const { allowed, used: postsToday } = await claimDailyQuota(db, {
      userId, kind: 'post', limit: postLimit, userRow: req.userRow
    });

    if (!allowed) {
      return res.status(429).json({
        message: `Daily post limit reached (${postLimit}/day with network size ${networkSize}). Follow more people to unlock more posts.`
      });
    }

    const interestTags = (req.userRow.interests || []).slice(0, 5);
    const { data: post, error } = await db.from('posts').insert({
      author_id: userId,
      content: content || '',
      interest_tags: interestTags,
      is_public: true
    }).select().single();
    if (error) throw error;

    if (mediaFiles.length) {
      /*
       * storage_key is written only when migration 011 has run. Sending the
       * column to a database without it fails the whole insert with PGRST204,
       * which would make posting impossible on a partially-migrated deployment
       * — so it is dropped and the post still goes through, exactly as rows
       * from the old multipart path already do.
       */
      const rows = mediaFiles.map(m => ({
        post_id: post.id,
        type: m.type,
        url: m.url,
        storage_key: m.storage_key || ''
      }));

      let { error: mErr } = await db.from('post_media').insert(rows);

      if (mErr && (mErr.code === 'PGRST204' || /storage_key/i.test(mErr.message || ''))) {
        if (!storageKeyWarned) {
          storageKeyWarned = true;
          console.warn(
            '[posts] post_media.storage_key is missing — uploaded objects cannot be ' +
            'swept or deleted with their post. Run server/db/migrations/011_post_media_keys.sql.'
          );
        }
        ({ error: mErr } = await db.from('post_media').insert(
          rows.map(({ storage_key, ...rest }) => rest)
        ));
      }

      if (mErr) throw mErr;
    }

    // The counter was already incremented by claimDailyQuota above.

    // Streak + challenge progress (best-effort)
    try {
      await touchUserActivity(userId, { ...req.userRow, posts_today: postsToday }, { metric: 'posts' });
    } catch (_) { /* ignore */ }

    const shaped = await loadPostBundle(db, post);
    res.status(201).json({
      post: shaped,
      postsToday,
      postLimit: postLimit === Infinity ? '∞' : postLimit
    });
  } catch (err) {
    /*
     * MediaError carries its own status and a message written for the person
     * who picked the file — "too large", "does not belong to you", "not a
     * supported image or video". Those are actionable, so they are returned as
     * they are rather than flattened into a generic 500.
     */
    if (err instanceof MediaError) {
      return res.status(err.status).json({ message: err.message });
    }
    // sendError already surfaces schema/config errors verbatim — they tell the
    // operator exactly what to run — and masks everything else.
    sendError(res, err, req, 'Could not publish that post');
  }
});

// POST /api/posts/:id/like
router.post('/:id/like', protect, asyncHandler(async (req, res) => {
  const db = getSupabase();
  const postId = req.params.id;
  const userId = req.user.id;

  const { data: existing } = await db
    .from('post_likes')
    .select('*')
    .eq('post_id', postId)
    .eq('user_id', userId)
    .maybeSingle();

  if (existing) {
    await db.from('post_likes').delete().eq('post_id', postId).eq('user_id', userId);
  } else {
    await db.from('post_likes').insert({ post_id: postId, user_id: userId });
    const { data: likedPost } = await db.from('posts').select('author_id').eq('id', postId).maybeSingle();
    if (likedPost?.author_id && likedPost.author_id !== userId) {
      pushNotification(likedPost.author_id, {
        type: 'like',
        title: `${req.user.name} liked your post`,
        body: '',
        link: '/feed'
      }).catch(() => {});
    }
  }

  const { count } = await db
    .from('post_likes')
    .select('*', { count: 'exact', head: true })
    .eq('post_id', postId);

  res.json({ likes: count || 0, liked: !existing });
}, "Could not load the feed"));

// POST /api/posts/:id/comment
router.post('/:id/comment', protect, asyncHandler(async (req, res) => {
  const content = sanitizeText(req.body.content, 2000);
  if (!content) return res.status(400).json({ message: 'Comment cannot be empty' });

  const db = getSupabase();
  const { data: post } = await db.from('posts').select('id, author_id').eq('id', req.params.id).maybeSingle();
  if (!post) return res.status(404).json({ message: 'Post not found' });

  const { error } = await db.from('post_comments').insert({
    post_id: req.params.id,
    author_id: req.user.id,
    content
  });
  if (error) throw error;

  if (post.author_id && post.author_id !== req.user.id) {
    pushNotification(post.author_id, {
      type: 'comment',
      title: `${req.user.name} commented on your post`,
      body: content.slice(0, 120),
      link: '/feed'
    }).catch(() => {});
  }

  const { data: comments } = await db
    .from('post_comments')
    .select('*')
    .eq('post_id', req.params.id)
    .order('created_at', { ascending: true });

  const authorIds = [...new Set((comments || []).map(c => c.author_id))];
  const { data: authors } = await db.from('users').select(withMediaColumns('id, name, avatar')).in('id', authorIds);
  const map = Object.fromEntries((authors || []).map(a => [a.id, a]));

  res.json({
    comments: (comments || []).map(c => ({
      _id: c.id,
      author: shapeAuthor(map[c.author_id] || { id: c.author_id }),
      content: c.content,
      createdAt: c.created_at
    }))
  });
}, "Could not load the feed"));

// POST /api/posts/:id/share
router.post('/:id/share', protect, asyncHandler(async (req, res) => {
  const db = getSupabase();
  const { data: post } = await db.from('posts').select('shares').eq('id', req.params.id).maybeSingle();
  if (!post) return res.status(404).json({ message: 'Post not found' });

  const shares = (post.shares || 0) + 1;
  const { error } = await db.from('posts').update({ shares }).eq('id', req.params.id);
  if (error) throw error;
  res.json({ shares });
}, "Could not load the feed"));

// DELETE /api/posts/:id
router.delete('/:id', protect, asyncHandler(async (req, res) => {
  const db = getSupabase();
  const { data: post } = await db.from('posts').select('*').eq('id', req.params.id).maybeSingle();
  if (!post) return res.status(404).json({ message: 'Post not found' });
  if (post.author_id !== req.user.id) {
    return res.status(403).json({ message: 'Not authorized to delete this post' });
  }
  const { error } = await db.from('posts').delete().eq('id', req.params.id);
  if (error) throw error;
  res.json({ message: 'Post deleted' });
}, "Could not load the feed"));

module.exports = router;
