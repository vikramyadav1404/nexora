const express = require('express');
const router = express.Router();
const { getSupabase } = require('../db/supabase');
const {
  isToday, getDailyQuestionLimit, shapeQuestion, shapeAnswer, shapeAuthor, authorFields,
  getVoteLists
} = require('../db/helpers');
const { protect } = require('../middleware/auth');
const { sendError, asyncHandler } = require('../utils/respond');
const { claimDailyQuota } = require('../utils/quota');
const { sanitizeText, escapePostgrestValue } = require('../utils/validate');

// GET /api/questions
router.get('/', protect, asyncHandler(async (req, res) => {
  /*
   * Both bounded. `?page=0` used to produce `from = -10`, which PostgREST turns
   * into a negative OFFSET and Postgres rejects -- a 500 for what is a client
   * mistake. `?limit=5000` fetched 5000 rows and then ran three queries per row
   * below: 15,000 round trips in one request. Every other paginated route in
   * this codebase caps; this one did not.
   */
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
  const { tag, search, sort = 'newest' } = req.query;
  const db = getSupabase();

  let query = db.from('questions').select('*', { count: 'exact' });

  if (tag) query = query.contains('tags', [tag]);
  /*
   * escapePostgrestValue, as routes/search.js and routes/users.js already do.
   * Interpolated raw, a comma injected an extra filter term and a bare `%`
   * matched every row -- utils/validate.js was written for exactly this and
   * this call site was missed.
   */
  if (search) {
    const q = escapePostgrestValue(String(search));
    query = query.or(`title.ilike.%${q}%,body.ilike.%${q}%`);
  }

  if (sort === 'newest' || sort === 'votes') {
    query = query.order('created_at', { ascending: false });
  }

  const from = (page - 1) * limit;
  const { data: questions, error, count } = await query.range(from, from + limit - 1);
  if (error) throw error;

  let list = questions || [];

  // Attach authors, vote counts, answer counts
  const shaped = await Promise.all(list.map(async (q) => {
    const [{ data: author }, votes, { count: answerCount }] = await Promise.all([
      db.from('users').select(authorFields()).eq('id', q.author_id).single(),
      getVoteLists(db, 'question_votes', 'question_id', q.id),
      db.from('answers').select('*', { count: 'exact', head: true }).eq('question_id', q.id)
    ]);

    // Placeholder answers array for list view (frontend uses length)
    const answers = Array.from({ length: answerCount || 0 }, (_, i) => ({ _id: `${q.id}-a${i}` }));

    return {
      ...shapeQuestion(q, {
        author: shapeAuthor(author),
        answers,
        upvotes: votes.upvotes,
        downvotes: votes.downvotes
      }),
      _upvoteCount: votes.upvotes.length,
      _answerCount: answerCount || 0
    };
  }));

  let result = shaped;
  if (sort === 'votes') {
    result = [...shaped].sort((a, b) => b._upvoteCount - a._upvoteCount);
  } else if (sort === 'unanswered') {
    result = shaped.filter(q => q._answerCount === 0);
  }

  // Clean internal fields
  result = result.map(({ _upvoteCount, _answerCount, ...q }) => q);

  const total = sort === 'unanswered' ? result.length : (count || 0);
  res.json({ questions: result, total, pages: Math.ceil(total / limit) || 1 });
}, "Could not load questions"));

// GET /api/questions/:id
router.get('/:id', protect, asyncHandler(async (req, res) => {
  const db = getSupabase();
  const { data: q, error } = await db.from('questions').select('*').eq('id', req.params.id).maybeSingle();
  if (error) throw error;
  if (!q) return res.status(404).json({ message: 'Question not found' });

  // Increment views
  await db.from('questions').update({ views: (q.views || 0) + 1 }).eq('id', q.id);
  q.views = (q.views || 0) + 1;

  const [{ data: author }, votes, { data: answerRows }] = await Promise.all([
    db.from('users').select(authorFields()).eq('id', q.author_id).single(),
    getVoteLists(db, 'question_votes', 'question_id', q.id),
    db.from('answers').select('*').eq('question_id', q.id).order('created_at', { ascending: true })
  ]);

  const answers = await Promise.all((answerRows || []).map(async (a) => {
    const [{ data: aAuthor }, aVotes] = await Promise.all([
      db.from('users').select(authorFields()).eq('id', a.author_id).single(),
      getVoteLists(db, 'answer_votes', 'answer_id', a.id)
    ]);
    return shapeAnswer(a, {
      author: shapeAuthor(aAuthor),
      upvotes: aVotes.upvotes,
      downvotes: aVotes.downvotes
    });
  }));

  res.json({
    question: shapeQuestion(q, {
      author: shapeAuthor(author),
      answers,
      upvotes: votes.upvotes,
      downvotes: votes.downvotes
    })
  });
}, "Could not load questions"));

// POST /api/questions
router.post('/', protect, asyncHandler(async (req, res) => {
  const db = getSupabase();
  const user = req.userRow;
  const { title, body, tags } = req.body;

  /*
   * Validated and capped, like every other write path in this codebase.
   *
   * These two were the exception: they went from req.body into the insert with
   * no sanitizeText, no length cap and no type check. A body up to the 2MB JSON
   * limit was stored verbatim, and `{"title": {"a":1}}` passed the truthiness
   * check below and put a JSON object into a TEXT column.
   *
   * Note what this does NOT do: sanitizeText trims and truncates, it does not
   * strip markup. A title containing HTML is still stored as typed, which is
   * correct -- the database holds text, and escaping belongs at each output.
   * The weekly digest renders titles into email and now escapes them there;
   * see cron.js. Storing raw and escaping on output is the right split, but it
   * only works if every output actually escapes.
   */
  /*
   * Type-checked before sanitizing. sanitizeText coerces with String(), so an
   * object arrives as the literal "[object Object]" -- truthy, non-empty, and
   * stored as the question's title. Rejecting is the only sensible answer.
   */
  if (typeof title !== 'string' || typeof body !== 'string') {
    return res.status(400).json({ message: 'Title and body must be text' });
  }

  const cleanTitle = sanitizeText(title, 300);
  const cleanBody = sanitizeText(body, 10000);

  if (!cleanTitle || !cleanBody) {
    return res.status(400).json({ message: 'Title and body are required' });
  }

  /*
   * Claimed before the insert, not after.
   *
   * This used to check req.userRow's counter and write it back at the end of
   * the request. Both halves read a value loaded once by protect, so two
   * concurrent requests both saw 0, both passed, and both wrote 1 -- a free
   * account could ask unlimited questions by firing them in parallel, which is
   * the whole thing the paid plans sell.
   */
  const limit = getDailyQuestionLimit(user);
  const { allowed } = await claimDailyQuota(db, {
    userId: user.id, kind: 'question', limit, userRow: user
  });

  if (!allowed) {
    const plan = user.subscription_plan || 'free';
    return res.status(429).json({
      message: `📊 Daily question limit reached! Your ${plan} plan allows ${limit} question(s)/day. Upgrade to ask more!`,
      limit,
      plan
    });
  }

  /*
   * Every branch here used to be a 500 waiting to happen: `{"tags": 5}` hit
   * `tags.split is not a function`, `{"tags": {}}` was truthy but not an array
   * so it took the same path, and `{"tags": [1,2]}` died on `t.trim`. All three
   * are 400-class inputs that answered 500 -- and the daily quota was already
   * claimed by then, so a free user lost their one question of the day to it.
   */
  const rawTags = Array.isArray(tags)
    ? tags
    : (typeof tags === 'string' ? tags.split(',') : []);

  let tagList = rawTags
    .filter(t => typeof t === 'string' || typeof t === 'number')
    .map(t => sanitizeText(String(t), 40).toLowerCase().trim())
    .filter(Boolean)
    .slice(0, 10);
  // Merge user interests so questions appear in Spaces
  const interests = user.interests || [];
  tagList = [...new Set([...tagList, ...interests.slice(0, 3)])];

  const { data: question, error } = await db.from('questions').insert({
    author_id: user.id,
    title: cleanTitle,
    body: cleanBody,
    tags: tagList
  }).select().single();
  if (error) throw error;

  // The counter was already incremented by claimDailyQuota above.

  const { data: author } = await db.from('users').select(authorFields()).eq('id', user.id).single();
  res.status(201).json({
    question: shapeQuestion(question, {
      author: shapeAuthor(author),
      answers: [],
      upvotes: [],
      downvotes: []
    })
  });
}, "Could not load questions"));

// POST /api/questions/:id/vote
router.post('/:id/vote', protect, asyncHandler(async (req, res) => {
  const { type } = req.body;
  const db = getSupabase();
  const questionId = req.params.id;
  const userId = req.user.id;

  // Same allowlist as answers.js: the branch below is `if up ... else down`, so
  // anything that is not 'up' -- including an empty body -- cast a downvote.
  if (type !== 'up' && type !== 'down') {
    return res.status(400).json({ message: "vote type must be 'up' or 'down'" });
  }

  const { data: question } = await db.from('questions').select('*').eq('id', questionId).maybeSingle();
  if (!question) return res.status(404).json({ message: 'Question not found' });
  if (question.author_id === userId) {
    return res.status(400).json({ message: 'You cannot vote on your own question' });
  }

  const { data: existing } = await db
    .from('question_votes')
    .select('*')
    .eq('question_id', questionId)
    .eq('user_id', userId)
    .maybeSingle();

  if (type === 'up') {
    if (existing?.vote_type === 'up') {
      await db.from('question_votes').delete().eq('question_id', questionId).eq('user_id', userId);
    } else {
      await db.from('question_votes').upsert({
        question_id: questionId,
        user_id: userId,
        vote_type: 'up'
      });
    }
  } else {
    if (existing?.vote_type === 'down') {
      await db.from('question_votes').delete().eq('question_id', questionId).eq('user_id', userId);
    } else {
      await db.from('question_votes').upsert({
        question_id: questionId,
        user_id: userId,
        vote_type: 'down'
      });
    }
  }

  const votes = await getVoteLists(db, 'question_votes', 'question_id', questionId);
  res.json({ upvotes: votes.upvotes.length, downvotes: votes.downvotes.length });
}, "Could not load questions"));

// DELETE /api/questions/:id
router.delete('/:id', protect, asyncHandler(async (req, res) => {
  const db = getSupabase();
  const { data: question } = await db.from('questions').select('*').eq('id', req.params.id).maybeSingle();
  if (!question) return res.status(404).json({ message: 'Question not found' });
  if (question.author_id !== req.user.id) {
    return res.status(403).json({ message: 'Not authorized' });
  }
  // answers cascade via FK
  await db.from('questions').delete().eq('id', question.id);
  res.json({ message: 'Question deleted' });
}, "Could not load questions"));

module.exports = router;
