const express = require('express');
const router = express.Router();
const { getSupabase } = require('../db/supabase');
const { protect } = require('../middleware/auth');
const { shapeUser, shapePost, shapeQuestion, loadAuthorMap } = require('../db/helpers');
const { INTERESTS } = require('../db/interests');
const { escapePostgrestValue } = require('../utils/validate');
const { sendError, asyncHandler } = require('../utils/respond');

const USER_FIELDS =
  'id, name, email, avatar, points, badges, bio, interests, subscription_plan, ' +
  'subscription_expires_at, gender, onboarding_completed, is_creator, creator_interest, ' +
  'language, phone, total_answers, is_active, role, created_at, updated_at';

const PEOPLE_LIMIT = 10;
const POST_LIMIT = 10;
const QUESTION_LIMIT = 10;

/**
 * Hard ceiling, and it is the function's, not ours.
 *
 * search_questions, search_posts and search_people all end in
 * `LIMIT LEAST(GREATEST(p_limit, 1), 50)`, so 50 is the most any of them will
 * ever return no matter what is asked for. Ranked results cannot use the
 * created_at keyset the feed uses either — rank is not monotonic with time, so
 * there is no cursor to carry. Paging past 50 needs a signature change and is
 * deliberately out of scope here.
 */
const RANKED_MAX = 50;

// Warn once, not per request, if migration 007 has not been run.
let searchRpcWarned = false;

/**
 * Rank-ordered results from the full-text functions in migration 007.
 *
 * Returns null when the functions are absent, so the caller can fall back
 * rather than fail — a database missing 007 should still have a working search
 * box, just an unranked one.
 *
 * posts and questions come back from the RPC with exactly the columns their
 * shapers read, so they are used directly. people cannot be: search_people
 * returns seven columns and shapeUser reads about twenty, so the RPC is used
 * for the ranking and a second query fetches the rows.
 */
async function rankedSearch(db, q, viewerId) {
  const [people, posts, questions] = await Promise.all([
    db.rpc('search_people', { p_query: q, p_viewer: viewerId, p_limit: PEOPLE_LIMIT }),
    db.rpc('search_posts', { p_query: q, p_limit: POST_LIMIT }),
    db.rpc('search_questions', { p_query: q, p_limit: QUESTION_LIMIT })
  ]);

  const missing = [people, posts, questions].find(
    r => r.error && (r.error.code === 'PGRST202' || /find the function/i.test(r.error.message || ''))
  );
  if (missing) return null;

  const firstError = [people, posts, questions].find(r => r.error);
  if (firstError) throw firstError.error;

  return {
    peopleRanked: people.data || [],
    postRows: posts.data || [],
    questionRows: questions.data || []
  };
}

/** The pre-007 behaviour, kept as the fallback path. */
async function likeSearch(db, q, viewerId) {
  const like = `%${q}%`;

  const [{ data: blockRows }, { data: peopleRaw }, { data: postRows }, { data: questionRows }] =
    await Promise.all([
      db.from('blocks').select('blocked_id').eq('blocker_id', viewerId),
      db.from('users').select(USER_FIELDS)
        .or(`name.ilike.${like},email.ilike.${like}`)
        .neq('id', viewerId)
        .limit(15),
      db.from('posts').select('*')
        .ilike('content', like)
        .eq('is_public', true)
        .order('created_at', { ascending: false })
        .limit(POST_LIMIT),
      db.from('questions').select('*')
        .or(`title.ilike.${like},body.ilike.${like}`)
        .order('created_at', { ascending: false })
        .limit(QUESTION_LIMIT)
    ]);

  const blocked = new Set((blockRows || []).map(b => b.blocked_id));
  return {
    peopleRows: (peopleRaw || []).filter(u => !blocked.has(u.id)).slice(0, PEOPLE_LIMIT),
    postRows: postRows || [],
    questionRows: questionRows || []
  };
}

// GET /api/search?q=
router.get('/', protect, asyncHandler(async (req, res) => {
  // Single shared escaper — this used to strip only %, _ and , which still
  // left `.` and `(` free to inject extra PostgREST filter terms. It still
  // matters on the fallback path, and costs nothing on the ranked one where
  // the query is a bound RPC parameter rather than part of a filter string.
  const q = escapePostgrestValue(req.query.q);
  if (q.length < 2) {
    return res.json({ people: [], posts: [], questions: [], spaces: [], query: q });
  }

  const db = getSupabase();
  const viewerId = req.user.id;

  let peopleRows;
  let postRows;
  let questionRows;

  const ranked = await rankedSearch(db, q, viewerId);

  if (ranked) {
    postRows = ranked.postRows;
    questionRows = ranked.questionRows;

    /*
     * Refetch the people rows, preserving rank order.
     *
     * `.in()` returns rows in whatever order Postgres finds them, so the
     * ranking would be lost if the results were used as they arrive. The RPC
     * order is the answer, and the map restores it.
     */
    const ids = ranked.peopleRanked.map(p => p.id);
    if (ids.length) {
      const { data, error } = await db.from('users').select(USER_FIELDS).in('id', ids);
      if (error) throw error;
      const byId = Object.fromEntries((data || []).map(u => [u.id, u]));
      peopleRows = ids.map(id => byId[id]).filter(Boolean);
    } else {
      peopleRows = [];
    }
  } else {
    if (!searchRpcWarned) {
      searchRpcWarned = true;
      console.warn(
        'search functions unavailable; serving unranked ILIKE results. ' +
        'Run server/db/migrations/007_search.sql to enable ranking.'
      );
    }
    ({ peopleRows, postRows, questionRows } = await likeSearch(db, q, viewerId));
  }

  const people = peopleRows.map(u => shapeUser(u));

  // One author query for both result sets, instead of one per row (was up to 20)
  const authors = await loadAuthorMap(db, [
    ...postRows.map(p => p.author_id),
    ...questionRows.map(x => x.author_id)
  ]);

  const posts = postRows.map(p =>
    shapePost(p, { author: authors[p.author_id], media: [], likes: [], comments: [] })
  );

  const questions = questionRows.map(item =>
    shapeQuestion(item, { author: authors[item.author_id], answers: [], upvotes: [], downvotes: [] })
  );

  const ql = q.toLowerCase();
  const spaces = INTERESTS.filter(i =>
    i.id.includes(ql) || i.label.toLowerCase().includes(ql)
  );

  res.json({ people, posts, questions, spaces, query: q });
}, 'Search is unavailable right now'));

module.exports = router;
module.exports.RANKED_MAX = RANKED_MAX;
