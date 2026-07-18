const express = require('express');
const router = express.Router();
const { getSupabase } = require('../db/supabase');
const { protect } = require('../middleware/auth');
const { shapeUser, shapePost, shapeQuestion, shapeAuthor, AUTHOR_FIELDS } = require('../db/helpers');
const { INTERESTS } = require('../db/interests');

// GET /api/search?q=
router.get('/', protect, async (req, res) => {
  try {
    const q = (req.query.q || '').trim().replace(/[%_,]/g, ' ').slice(0, 80);
    if (q.length < 2) {
      return res.json({ people: [], posts: [], questions: [], spaces: [], query: q });
    }

    const db = getSupabase();
    // PostgREST ilike patterns
    const like = `%${q}%`;

    // Blocked users
    const { data: blockRows } = await db
      .from('blocks')
      .select('blocked_id')
      .eq('blocker_id', req.user.id);
    const blocked = new Set((blockRows || []).map(b => b.blocked_id));

    const [{ data: peopleRaw }, { data: postsRaw }, { data: questionsRaw }] = await Promise.all([
      db.from('users')
        .select('id, name, email, avatar, points, badges, bio, interests, subscription_plan, subscription_expires_at, gender, onboarding_completed, is_creator, creator_interest, language, phone, total_answers, is_active, role, created_at, updated_at')
        .or(`name.ilike.${like},email.ilike.${like}`)
        .neq('id', req.user.id)
        .limit(15),
      db.from('posts')
        .select('*')
        .ilike('content', like)
        .eq('is_public', true)
        .order('created_at', { ascending: false })
        .limit(10),
      db.from('questions')
        .select('*')
        .or(`title.ilike.${like},body.ilike.${like}`)
        .order('created_at', { ascending: false })
        .limit(10)
    ]);

    const people = (peopleRaw || [])
      .filter(u => !blocked.has(u.id))
      .slice(0, 10)
      .map(u => shapeUser(u));

    const posts = await Promise.all((postsRaw || []).map(async (p) => {
      const { data: author } = await db.from('users').select(AUTHOR_FIELDS).eq('id', p.author_id).single();
      return shapePost(p, { author: shapeAuthor(author), media: [], likes: [], comments: [] });
    }));

    const questions = await Promise.all((questionsRaw || []).map(async (item) => {
      const { data: author } = await db.from('users').select(AUTHOR_FIELDS).eq('id', item.author_id).single();
      return shapeQuestion(item, { author: shapeAuthor(author), answers: [], upvotes: [], downvotes: [] });
    }));

    const ql = q.toLowerCase();
    const spaces = INTERESTS.filter(i =>
      i.id.includes(ql) || i.label.toLowerCase().includes(ql)
    );

    res.json({ people, posts, questions, spaces, query: q });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
