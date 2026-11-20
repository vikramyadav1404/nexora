const express = require('express');
const router = express.Router();
const { getSupabase } = require('../db/supabase');
const { protect } = require('../middleware/auth');
const { shapePost, shapeQuestion, loadAuthorMap } = require('../db/helpers');
const { publicUser } = require('../db/serialize');
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
 * Hard ceiling per page, and it is the function's, not ours.
 *
 * search_questions and search_posts end in `LIMIT LEAST(GREATEST(p_limit, 1),
 * 50)`. Since migration 022 that is a page size, not a cap on the results:
 * they take a (rank, created_at, id) keyset cursor, so a client can page past
 * 50 one page at a time. search_people still has no cursor.
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
  // One extra row per ranked type says whether a next page exists.
  const [people, posts, questions] = await Promise.all([
    db.rpc('search_people', { p_query: q, p_viewer: viewerId, p_limit: PEOPLE_LIMIT }),
    db.rpc('search_posts', { p_query: q, p_limit: POST_LIMIT + 1 }),
    db.rpc('search_questions', { p_query: q, p_limit: QUESTION_LIMIT + 1 })
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

/**
 * Opaque keyset cursor for ranked results: the last row's (rank, created_at,
 * id), the exact order key the functions sort on. Rank is a REAL the function
 * computed; it goes back unchanged, so the comparison is against the same
 * value, not a re-derived one.
 */
function encodeSearchCursor(row) {
  if (!row) return null;
  return Buffer.from(JSON.stringify([row.rank, row.created_at, row.id])).toString('base64url');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns null for anything that is not a well-formed cursor. */
function decodeSearchCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [rank, ts, id] = parsed;
    if (typeof rank !== 'number' || !Number.isFinite(rank)) return null;
    if (typeof ts !== 'string' || Number.isNaN(Date.parse(ts))) return null;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
    return { rank, ts, id };
  } catch {
    return null;
  }
}

/** Split a limit+1 fetch into the page and the cursor for the next one. */
function pageOf(rows, size) {
  const list = rows || [];
  const hasMore = list.length > size;
  const page = hasMore ? list.slice(0, size) : list;
  return { page, nextCursor: hasMore ? encodeSearchCursor(page[page.length - 1]) : null };
}

const PAGED_TYPES = {
  posts: { fn: 'search_posts', size: POST_LIMIT },
  questions: { fn: 'search_questions', size: QUESTION_LIMIT }
};

// GET /api/search?q=
router.get('/', protect, asyncHandler(async (req, res) => {
  // Single shared escaper — this used to strip only %, _ and , which still
  // left `.` and `(` free to inject extra PostgREST filter terms. It still
  // matters on the fallback path, and costs nothing on the ranked one where
  // the query is a bound RPC parameter rather than part of a filter string.
  const q = escapePostgrestValue(req.query.q);
  if (q.length < 2) {
    return res.json({ people: [], posts: [], questions: [], spaces: [], query: q, more: { posts: null, questions: null } });
  }

  const db = getSupabase();
  const viewerId = req.user.id;

  /*
   * ?type=posts|questions&cursor=… : the next page of one ranked list. The
   * cursor came from a previous response's `more`, or `nextCursor` here.
   */
  if (req.query.type !== undefined || req.query.cursor !== undefined) {
    const spec = PAGED_TYPES[req.query.type];
    const cursor = decodeSearchCursor(req.query.cursor);
    if (!spec || !cursor) {
      return res.status(400).json({ message: 'type must be posts or questions, with a valid cursor' });
    }
    const { data, error } = await db.rpc(spec.fn, {
      p_query: q,
      p_limit: spec.size + 1,
      p_cursor_rank: cursor.rank,
      p_cursor_ts: cursor.ts,
      p_cursor_id: cursor.id
    });
    if (error) {
      /*
       * PGRST202 here means 022 is not applied: the 007 functions exist but
       * take no cursor. The first page still works (it passes no cursor);
       * only "load more" cannot, so say exactly that rather than a bare 500.
       * The message matches respond.js's safe-setup pattern, so it is a 503.
       */
      if (error.code === 'PGRST202') {
        const err = new Error(
          `${spec.fn} takes no cursor yet (PGRST202). ` +
          'Run server/db/migrations/022_search_paging.sql in the Supabase SQL Editor.'
        );
        err.code = 'PGRST202';
        throw err;
      }
      throw error;
    }
    const { page, nextCursor } = pageOf(data, spec.size);
    const authors = await loadAuthorMap(db, page.map(r => r.author_id));
    const items = req.query.type === 'posts'
      ? page.map(p => shapePost(p, { author: authors[p.author_id], media: [], likes: [], comments: [] }))
      : page.map(x => shapeQuestion(x, { author: authors[x.author_id], answers: [], upvotes: [], downvotes: [] }));
    return res.json({ type: req.query.type, items, nextCursor, query: q });
  }

  let peopleRows;
  // Cursors for the next page of each ranked list; null on the ILIKE fallback.
  const more = { posts: null, questions: null };
  let postRows;
  let questionRows;

  const ranked = await rankedSearch(db, q, viewerId);

  if (ranked) {
    const posts = pageOf(ranked.postRows, POST_LIMIT);
    const questions = pageOf(ranked.questionRows, QUESTION_LIMIT);
    postRows = posts.page;
    questionRows = questions.page;
    more.posts = posts.nextCursor;
    more.questions = questions.nextCursor;

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

  /*
   * publicUser, the allowlist shape. This returns up to ten arbitrary users to
   * any logged-in caller, so it must carry nothing personal.
   *
   * This line said shapePerson before, with a comment claiming the contact-detail
   * problem was solved. It was not: shapePerson dropped phone and kept email, so
   * a search for a common first name still returned ten strangers' addresses --
   * and Search.jsx rendered one as the result subtitle whenever a person had no
   * interests set. The comment is why nobody re-checked.
   */
  const people = peopleRows.map(publicUser);

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

  res.json({ people, posts, questions, spaces, query: q, more });
}, 'Search is unavailable right now'));

module.exports = router;
module.exports.RANKED_MAX = RANKED_MAX;
