const express = require('express');
const router = express.Router();
const { getSupabase } = require('../db/supabase');
const {
  isToday, getDailyQuestionLimit, shapeQuestion, shapeAnswer, shapeAuthor, AUTHOR_FIELDS
} = require('../db/helpers');
const { protect } = require('../middleware/auth');
const { sendError } = require('../utils/respond');

async function getVoteLists(db, table, idCol, id) {
  const { data } = await db.from(table).select('user_id, vote_type').eq(idCol, id);
  const upvotes = [];
  const downvotes = [];
  (data || []).forEach(v => {
    if (v.vote_type === 'up') upvotes.push(v.user_id);
    else downvotes.push(v.user_id);
  });
  return { upvotes, downvotes };
}

// GET /api/questions
router.get('/', protect, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const { tag, search, sort = 'newest' } = req.query;
    const db = getSupabase();

    let query = db.from('questions').select('*', { count: 'exact' });

    if (tag) query = query.contains('tags', [tag]);
    if (search) query = query.or(`title.ilike.%${search}%,body.ilike.%${search}%`);

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
        db.from('users').select(AUTHOR_FIELDS).eq('id', q.author_id).single(),
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
  } catch (err) { sendError(res, err, req, "Could not load questions"); }
});

// GET /api/questions/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const db = getSupabase();
    const { data: q, error } = await db.from('questions').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!q) return res.status(404).json({ message: 'Question not found' });

    // Increment views
    await db.from('questions').update({ views: (q.views || 0) + 1 }).eq('id', q.id);
    q.views = (q.views || 0) + 1;

    const [{ data: author }, votes, { data: answerRows }] = await Promise.all([
      db.from('users').select(AUTHOR_FIELDS).eq('id', q.author_id).single(),
      getVoteLists(db, 'question_votes', 'question_id', q.id),
      db.from('answers').select('*').eq('question_id', q.id).order('created_at', { ascending: true })
    ]);

    const answers = await Promise.all((answerRows || []).map(async (a) => {
      const [{ data: aAuthor }, aVotes] = await Promise.all([
        db.from('users').select(AUTHOR_FIELDS).eq('id', a.author_id).single(),
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
  } catch (err) { sendError(res, err, req, "Could not load questions"); }
});

// POST /api/questions
router.post('/', protect, async (req, res) => {
  try {
    const db = getSupabase();
    const user = req.userRow;
    const { title, body, tags } = req.body;

    if (!title || !body) return res.status(400).json({ message: 'Title and body are required' });

    const limit = getDailyQuestionLimit(user);
    let questionsToday = user.questions_today || 0;

    if (isToday(user.last_question_date)) {
      if (limit !== Infinity && questionsToday >= limit) {
        const plan = user.subscription_plan || 'free';
        return res.status(429).json({
          message: `📊 Daily question limit reached! Your ${plan} plan allows ${limit} question(s)/day. Upgrade to ask more!`,
          limit,
          plan
        });
      }
    } else {
      questionsToday = 0;
    }

    let tagList = tags
      ? (Array.isArray(tags) ? tags : tags.split(',')).map(t => t.trim().toLowerCase()).filter(Boolean)
      : [];
    // Merge user interests so questions appear in Spaces
    const interests = user.interests || [];
    tagList = [...new Set([...tagList, ...interests.slice(0, 3)])];

    const { data: question, error } = await db.from('questions').insert({
      author_id: user.id,
      title,
      body,
      tags: tagList
    }).select().single();
    if (error) throw error;

    questionsToday += 1;
    await db.from('users').update({
      questions_today: questionsToday,
      last_question_date: new Date().toISOString()
    }).eq('id', user.id);

    const { data: author } = await db.from('users').select(AUTHOR_FIELDS).eq('id', user.id).single();
    res.status(201).json({
      question: shapeQuestion(question, {
        author: shapeAuthor(author),
        answers: [],
        upvotes: [],
        downvotes: []
      })
    });
  } catch (err) { sendError(res, err, req, "Could not load questions"); }
});

// POST /api/questions/:id/vote
router.post('/:id/vote', protect, async (req, res) => {
  try {
    const { type } = req.body;
    const db = getSupabase();
    const questionId = req.params.id;
    const userId = req.user.id;

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
  } catch (err) { sendError(res, err, req, "Could not load questions"); }
});

// DELETE /api/questions/:id
router.delete('/:id', protect, async (req, res) => {
  try {
    const db = getSupabase();
    const { data: question } = await db.from('questions').select('*').eq('id', req.params.id).maybeSingle();
    if (!question) return res.status(404).json({ message: 'Question not found' });
    if (question.author_id !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    // answers cascade via FK
    await db.from('questions').delete().eq('id', question.id);
    res.json({ message: 'Question deleted' });
  } catch (err) { sendError(res, err, req, "Could not load questions"); }
});

module.exports = router;
