const express = require('express');
const router = express.Router();
const { getSupabase } = require('../db/supabase');
const { protect } = require('../middleware/auth');
const { INTERESTS } = require('../db/interests');
const {
  shapeUser, shapePost, shapeQuestion, shapeAuthor, AUTHOR_FIELDS
} = require('../db/helpers');

// GET /api/spaces
router.get('/', protect, async (req, res) => {
  try {
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
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/spaces/:id
router.get('/:id', protect, async (req, res) => {
  try {
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

    const posts = await Promise.all((postRows || []).map(async (p) => {
      const [{ data: author }, { data: media }, { data: likes }] = await Promise.all([
        db.from('users').select(AUTHOR_FIELDS).eq('id', p.author_id).single(),
        db.from('post_media').select('*').eq('post_id', p.id),
        db.from('post_likes').select('user_id').eq('post_id', p.id)
      ]);
      return shapePost(p, {
        author: shapeAuthor(author),
        media: media || [],
        likes: likes || [],
        comments: []
      });
    }));

    const { data: qRows } = await db
      .from('questions')
      .select('*')
      .contains('tags', [interest])
      .order('created_at', { ascending: false })
      .limit(20);

    const questions = await Promise.all((qRows || []).map(async (q) => {
      const { data: author } = await db.from('users').select(AUTHOR_FIELDS).eq('id', q.author_id).single();
      return shapeQuestion(q, {
        author: shapeAuthor(author),
        answers: [],
        upvotes: [],
        downvotes: []
      });
    }));

    const { data: memberRows } = await db
      .from('users')
      .select('*')
      .or(`interests.cs.{${interest}},creator_interest.eq.${interest}`)
      .eq('is_active', true)
      .limit(20);

    const members = (memberRows || []).map(u => shapeUser(u));

    res.json({ space, posts, questions, members });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
