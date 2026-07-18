const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getSupabase } = require('../db/supabase');
const {
  isToday, getDailyPostLimit, shapePost, shapeAuthor, AUTHOR_FIELDS
} = require('../db/helpers');
const { protect } = require('../middleware/auth');
const { touchUserActivity, pushNotification } = require('../db/features');
const { uploadMedia } = require('../utils/storage');
const { writeLimiter } = require('../middleware/rateLimit');
const { sanitizeText } = require('../utils/validate');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../uploads/posts');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

async function loadPostBundle(db, post) {
  const [{ data: author }, { data: media }, { data: likes }, { data: comments }] = await Promise.all([
    db.from('users').select(AUTHOR_FIELDS).eq('id', post.author_id).single(),
    db.from('post_media').select('*').eq('post_id', post.id),
    db.from('post_likes').select('user_id').eq('post_id', post.id),
    db.from('post_comments').select('*').eq('post_id', post.id).order('created_at', { ascending: true })
  ]);

  let shapedComments = [];
  if (comments?.length) {
    const authorIds = [...new Set(comments.map(c => c.author_id))];
    const { data: authors } = await db.from('users').select('id, name, avatar').in('id', authorIds);
    const map = Object.fromEntries((authors || []).map(a => [a.id, a]));
    shapedComments = comments.map(c => ({
      ...c,
      author: shapeAuthor(map[c.author_id] || { id: c.author_id, name: 'User' })
    }));
  }

  return shapePost(post, {
    author: shapeAuthor(author),
    media: media || [],
    likes: likes || [],
    comments: shapedComments
  });
}

// GET /api/posts — personalized by interests + follows when available
router.get('/', protect, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    const db = getSupabase();
    const interests = req.userRow.interests || [];
    const personalized = req.query.personalized !== '0';

    // Who the user follows
    const { data: followRows } = await db
      .from('follows')
      .select('following_id')
      .eq('follower_id', req.user.id);
    const followingIds = (followRows || []).map(f => f.following_id);

    // Pull a larger window then rank for personalization
    const fetchLimit = personalized ? Math.max(to + 1, 60) : to + 1;
    const { data: posts, error } = await db
      .from('posts')
      .select('*')
      .eq('is_public', true)
      .order('created_at', { ascending: false })
      .limit(fetchLimit);

    if (error) throw error;

    let ranked = posts || [];

    if (personalized && (interests.length || followingIds.length)) {
      ranked = [...ranked].sort((a, b) => {
        const score = (p) => {
          let s = 0;
          if (followingIds.includes(p.author_id)) s += 50;
          const tags = p.interest_tags || [];
          if (tags.some(t => interests.includes(t))) s += 30;
          if (p.seed_key) s += 5;
          // slight recency bias kept by original order as tiebreaker
          return s;
        };
        return score(b) - score(a);
      });
    }

    const pageSlice = ranked.slice(from, to + 1);
    const bundled = await Promise.all(pageSlice.map(p => loadPostBundle(db, p)));
    const total = ranked.length;
    res.json({
      posts: bundled,
      total,
      pages: Math.ceil(total / limit) || 1,
      personalized: personalized && interests.length > 0,
      interests
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

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
        message: '🚫 Follow interest accounts or add friends to post. Finish onboarding or open Spaces → Follow hubs.'
      });
    }

    let postsToday = req.userRow.posts_today || 0;
    if (isToday(req.userRow.last_post_date)) {
      if (postLimit !== Infinity && postsToday >= postLimit) {
        return res.status(429).json({
          message: `⏰ Daily post limit reached (${postLimit}/day with network size ${networkSize}). Follow more people to unlock more posts.`
        });
      }
    } else {
      postsToday = 0;
    }

    const content = sanitizeText(req.body.content, 5000);
    const mediaFiles = [];
    if (req.files?.length) {
      for (const f of req.files) {
        const up = await uploadMedia(f, { bucket: 'posts', folder: userId });
        mediaFiles.push({
          type: (f.mimetype || '').startsWith('image') ? 'image' : 'video',
          url: up.url
        });
      }
    }

    if (!content && mediaFiles.length === 0) {
      return res.status(400).json({ message: 'Post must have content or media' });
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
      const { error: mErr } = await db.from('post_media').insert(
        mediaFiles.map(m => ({ post_id: post.id, type: m.type, url: m.url }))
      );
      if (mErr) throw mErr;
    }

    postsToday += 1;
    await db.from('users').update({
      posts_today: postsToday,
      last_post_date: new Date().toISOString()
    }).eq('id', userId);

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
    console.error('create post:', err.message);
    if (err.message?.includes('column') || err.code === 'PGRST204') {
      return res.status(503).json({
        message: 'Database schema incomplete. Run server/db/migrations/001_setup_step_a.sql in Supabase.'
      });
    }
    res.status(500).json({ message: err.message });
  }
});

// POST /api/posts/:id/like
router.post('/:id/like', protect, async (req, res) => {
  try {
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
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/posts/:id/comment
router.post('/:id/comment', protect, async (req, res) => {
  try {
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
    const { data: authors } = await db.from('users').select('id, name, avatar').in('id', authorIds);
    const map = Object.fromEntries((authors || []).map(a => [a.id, a]));

    res.json({
      comments: (comments || []).map(c => ({
        _id: c.id,
        author: shapeAuthor(map[c.author_id] || { id: c.author_id }),
        content: c.content,
        createdAt: c.created_at
      }))
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/posts/:id/share
router.post('/:id/share', protect, async (req, res) => {
  try {
    const db = getSupabase();
    const { data: post } = await db.from('posts').select('shares').eq('id', req.params.id).maybeSingle();
    if (!post) return res.status(404).json({ message: 'Post not found' });

    const shares = (post.shares || 0) + 1;
    const { error } = await db.from('posts').update({ shares }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ shares });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/posts/:id
router.delete('/:id', protect, async (req, res) => {
  try {
    const db = getSupabase();
    const { data: post } = await db.from('posts').select('*').eq('id', req.params.id).maybeSingle();
    if (!post) return res.status(404).json({ message: 'Post not found' });
    if (post.author_id !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to delete this post' });
    }
    const { error } = await db.from('posts').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: 'Post deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
