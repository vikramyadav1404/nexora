const express = require('express');
const router = express.Router();
const { getSupabase } = require('../db/supabase');
const { protect } = require('../middleware/auth');
const { sendError, asyncHandler } = require('../utils/respond');
const {
  shapePost, shapeQuestion, shapeAuthor, authorFields,
  withMediaColumns
} = require('../db/helpers');

async function loadPostBundle(db, post) {
  const [{ data: author }, { data: media }, { data: likes }, { data: comments }] = await Promise.all([
    db.from('users').select(authorFields()).eq('id', post.author_id).single(),
    db.from('post_media').select('*').eq('post_id', post.id),
    db.from('post_likes').select('user_id').eq('post_id', post.id),
    db.from('post_comments').select('*').eq('post_id', post.id).order('created_at', { ascending: true })
  ]);

  let shapedComments = [];
  if (comments?.length) {
    const authorIds = [...new Set(comments.map(c => c.author_id))];
    const { data: authors } = await db.from('users').select(withMediaColumns('id, name, avatar')).in('id', authorIds);
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

async function loadQuestionLite(db, q) {
  const { data: author } = await db.from('users').select(authorFields()).eq('id', q.author_id).single();
  const { data: votes } = await db.from('question_votes').select('user_id, vote_type').eq('question_id', q.id);
  const upvotes = [];
  const downvotes = [];
  (votes || []).forEach(v => {
    if (v.vote_type === 'up') upvotes.push(v.user_id);
    else downvotes.push(v.user_id);
  });
  return shapeQuestion(q, {
    author: shapeAuthor(author),
    upvotes,
    downvotes,
    answers: []
  });
}

// GET /api/bookmarks
router.get('/', protect, asyncHandler(async (req, res) => {
  const db = getSupabase();
  const { data: rows, error } = await db
    .from('bookmarks')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });

  if (error) throw error;

  const enriched = [];
  for (const b of rows || []) {
    if (b.target_type === 'post') {
      const { data: post } = await db.from('posts').select('*').eq('id', b.target_id).maybeSingle();
      if (!post) continue;
      enriched.push({
        type: 'post',
        id: b.target_id,
        createdAt: b.created_at,
        item: await loadPostBundle(db, post)
      });
    } else if (b.target_type === 'question') {
      const { data: q } = await db.from('questions').select('*').eq('id', b.target_id).maybeSingle();
      if (!q) continue;
      enriched.push({
        type: 'question',
        id: b.target_id,
        createdAt: b.created_at,
        item: await loadQuestionLite(db, q)
      });
    }
  }

  res.json({ bookmarks: enriched });
}, "Could not update your saved items"));

// POST /api/bookmarks  { type, id }
router.post('/', protect, asyncHandler(async (req, res) => {
  const { type, id } = req.body;
  if (!type || !id || !['post', 'question'].includes(type)) {
    return res.status(400).json({ message: 'type and id required' });
  }

  const db = getSupabase();
  const { error } = await db.from('bookmarks').upsert({
    user_id: req.user.id,
    target_type: type,
    target_id: id
  }, { onConflict: 'user_id,target_type,target_id' });

  if (error) throw error;
  res.json({ message: 'Saved', bookmarked: true });
}, "Could not update your saved items"));

// DELETE /api/bookmarks  { type, id }
router.delete('/', protect, asyncHandler(async (req, res) => {
  const { type, id } = req.body;
  if (!type || !id) {
    return res.status(400).json({ message: 'type and id required' });
  }

  const { error } = await getSupabase()
    .from('bookmarks')
    .delete()
    .eq('user_id', req.user.id)
    .eq('target_type', type)
    .eq('target_id', id);

  if (error) throw error;
  res.json({ message: 'Removed', bookmarked: false });
}, "Could not update your saved items"));

module.exports = router;
