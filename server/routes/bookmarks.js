const express = require('express');
const router = express.Router();
const { getSupabase } = require('../db/supabase');
const { protect } = require('../middleware/auth');
const { sendError, asyncHandler } = require('../utils/respond');
const {
  shapeQuestion, shapeAuthor, authorFields, loadPostBundles
} = require('../db/helpers');

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

  /*
   * Fetch every saved post in one query, then hydrate them all in one batch.
   *
   * This used to loop: one `posts` lookup per bookmark, then a private
   * per-post loader that issued five more. Someone with 20 saved posts cost
   * about 120 round trips to open the page. It is now two queries plus the
   * five inside loadPostBundles, regardless of how many are saved.
   */
  const postIds = (rows || []).filter(b => b.target_type === 'post').map(b => b.target_id);
  const questionIds = (rows || []).filter(b => b.target_type === 'question').map(b => b.target_id);

  const [{ data: posts }, { data: questions }] = await Promise.all([
    postIds.length ? db.from('posts').select('*').in('id', postIds) : { data: [] },
    questionIds.length ? db.from('questions').select('*').in('id', questionIds) : { data: [] }
  ]);

  const bundles = await loadPostBundles(db, posts || []);
  const postById = Object.fromEntries(bundles.map((p, i) => [(posts || [])[i].id, p]));

  // loadQuestionLite is still per-question; questions carry far less with them
  // and a saved-question list is short.
  const questionById = Object.fromEntries(
    await Promise.all((questions || []).map(async q => [q.id, await loadQuestionLite(db, q)]))
  );

  // Rebuild in the original order — `rows` is already newest-first.
  const enriched = [];
  for (const b of rows || []) {
    const item = b.target_type === 'post' ? postById[b.target_id] : questionById[b.target_id];
    if (!item) continue; // the post or question was deleted after being saved
    enriched.push({ type: b.target_type, id: b.target_id, createdAt: b.created_at, item });
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
