const express = require('express');
const router = express.Router();
const { getSupabase } = require('../db/supabase');
const { protect } = require('../middleware/auth');
const { sendError } = require('../utils/respond');
const {
  shapePost, shapeQuestion, shapeAuthor, authorFields
} = require('../db/helpers');

// GET /api/digests/weekly
router.get('/weekly', protect, async (req, res) => {
  try {
    const db = getSupabase();
    const interests = req.userRow.interests || [];
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

    let postsQuery = db
      .from('posts')
      .select('*')
      .eq('is_public', true)
      .gte('created_at', weekAgo)
      .order('created_at', { ascending: false })
      .limit(40);

    const { data: postRows } = await postsQuery;
    let filteredPosts = postRows || [];
    if (interests.length) {
      filteredPosts = filteredPosts.filter(p =>
        (p.interest_tags || []).some(t => interests.includes(t))
      );
    }
    filteredPosts = filteredPosts.slice(0, 5);

    const topPosts = await Promise.all(filteredPosts.map(async (p) => {
      const { data: author } = await db.from('users').select(authorFields()).eq('id', p.author_id).single();
      return shapePost(p, { author: shapeAuthor(author), media: [], likes: [], comments: [] });
    }));

    const { data: qRows } = await db
      .from('questions')
      .select('*')
      .gte('created_at', weekAgo)
      .order('created_at', { ascending: false })
      .limit(40);

    let filteredQs = qRows || [];
    if (interests.length) {
      filteredQs = filteredQs.filter(q =>
        (q.tags || []).some(t => interests.includes(t))
      );
    }
    filteredQs = filteredQs.slice(0, 5);

    const topQuestions = await Promise.all(filteredQs.map(async (q) => {
      const { data: author } = await db.from('users').select(authorFields()).eq('id', q.author_id).single();
      return shapeQuestion(q, {
        author: shapeAuthor(author),
        answers: [],
        upvotes: [],
        downvotes: []
      });
    }));

    res.json({
      title: 'Your weekly Nexora digest',
      interests,
      streak: req.userRow.streak_count || 0,
      topPosts,
      topQuestions,
      generatedAt: new Date().toISOString()
    });
  } catch (err) { sendError(res, err, req, "Could not build your digest"); }
});

module.exports = router;
