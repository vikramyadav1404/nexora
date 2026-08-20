const express = require('express');
const router = express.Router();
const { getSupabase } = require('../db/supabase');
const { protect } = require('../middleware/auth');
const { INTERESTS } = require('../db/interests');
const { sendError, asyncHandler } = require('../utils/respond');
const {
  shapePerson, shapeQuestion, shapeAuthor, loadPostBundles, loadAuthorMap
} = require('../db/helpers');

// GET /api/spaces
router.get('/', protect, asyncHandler(async (req, res) => {
  const db = getSupabase();

  const [{ data: posts }, { data: questions }, { data: users }] = await Promise.all([
    db.from('posts').select('id, interest_tags').eq('is_public', true).limit(500),
    db.from('questions').select('id, tags').limit(500),
    db.from('users').select('id, interests, creator_interest, is_creator').eq('is_active', true).limit(500)
  ]);

  const spaces = INTERESTS.map(i => {
    const postCount = (posts || []).filter(p => (p.interest_tags || []).includes(i.id)).length;
    const questionCount = (questions || []).filter(q => (q.tags || []).includes(i.id)).length;
    const memberCount = (users || []).filter(u =>
      (u.interests || []).includes(i.id) || u.creator_interest === i.id
    ).length;
    return { ...i, postCount, questionCount, memberCount };
  });

  res.json({ spaces });
}, "Could not load Spaces"));

// GET /api/spaces/:id
router.get('/:id', protect, asyncHandler(async (req, res) => {
  const space = INTERESTS.find(i => i.id === req.params.id);
  if (!space) return res.status(404).json({ message: 'Space not found' });

  const db = getSupabase();
  const interest = space.id;

  const { data: postRows } = await db
    .from('posts')
    .select('*')
    .contains('interest_tags', [interest])
    .eq('is_public', true)
    .order('created_at', { ascending: false })
    .limit(20);

  // Three queries per post before this — 60 for a full Space. Now four total,
  // and comments stay unfetched because this page never renders them.
  const posts = await loadPostBundles(db, postRows || [], { withComments: false });

  const { data: qRows } = await db
    .from('questions')
    .select('*')
    .contains('tags', [interest])
    .order('created_at', { ascending: false })
    .limit(20);

  // Same shape as before, but one author lookup for all 20 rather than one each.
  const qAuthors = await loadAuthorMap(db, (qRows || []).map(q => q.author_id));
  const questions = (qRows || []).map(q =>
    shapeQuestion(q, {
      author: qAuthors[q.author_id] || shapeAuthor({ id: q.author_id, name: 'User' }),
      answers: [],
      upvotes: [],
      downvotes: []
    })
  );

  const { data: memberRows } = await db
    .from('users')
    .select('*')
    .or(`interests.cs.{${interest}},creator_interest.eq.${interest}`)
    .eq('is_active', true)
    .limit(20);

  // shapePerson: a Space member list is other people. shapeUser would return
  // every member's email and phone to anyone who opened the Space, and there
  // are only ~16 interest ids to walk.
  const members = (memberRows || []).map(shapePerson);

  res.json({ space, posts, questions, members });
}, "Could not load Spaces"));

module.exports = router;
