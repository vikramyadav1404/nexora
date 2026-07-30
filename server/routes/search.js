const express = require('express');
const router = express.Router();
const { getSupabase } = require('../db/supabase');
const { protect } = require('../middleware/auth');
const { shapeUser, shapePost, shapeQuestion, loadAuthorMap } = require('../db/helpers');
const { INTERESTS } = require('../db/interests');
const { escapePostgrestValue } = require('../utils/validate');
const { sendError } = require('../utils/respond');

const USER_FIELDS =
  'id, name, email, avatar, points, badges, bio, interests, subscription_plan, ' +
  'subscription_expires_at, gender, onboarding_completed, is_creator, creator_interest, ' +
  'language, phone, total_answers, is_active, role, created_at, updated_at';

// GET /api/search?q=
router.get('/', protect, async (req, res) => {
  try {
    // Single shared escaper — this used to strip only %, _ and , which still
    // left `.` and `(` free to inject extra PostgREST filter terms.
    const q = escapePostgrestValue(req.query.q);
    if (q.length < 2) {
      return res.json({ people: [], posts: [], questions: [], spaces: [], query: q });
    }

    const db = getSupabase();
    const like = `%${q}%`;

    const { data: blockRows } = await db
      .from('blocks')
      .select('blocked_id')
      .eq('blocker_id', req.user.id);
    const blocked = new Set((blockRows || []).map(b => b.blocked_id));

    const [{ data: peopleRaw }, { data: postsRaw }, { data: questionsRaw }] = await Promise.all([
      db.from('users')
        .select(USER_FIELDS)
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

    // One author query for both result sets, instead of one per row (was up to 20)
    const authors = await loadAuthorMap(db, [
      ...(postsRaw || []).map(p => p.author_id),
      ...(questionsRaw || []).map(x => x.author_id)
    ]);

    const posts = (postsRaw || []).map(p =>
      shapePost(p, { author: authors[p.author_id], media: [], likes: [], comments: [] })
    );

    const questions = (questionsRaw || []).map(item =>
      shapeQuestion(item, { author: authors[item.author_id], answers: [], upvotes: [], downvotes: [] })
    );

    const ql = q.toLowerCase();
    const spaces = INTERESTS.filter(i =>
      i.id.includes(ql) || i.label.toLowerCase().includes(ql)
    );

    res.json({ people, posts, questions, spaces, query: q });
  } catch (err) {
    sendError(res, err, req, 'Search is unavailable right now');
  }
});

module.exports = router;
