const express = require('express');
const router = express.Router();
const { getSupabase } = require('../db/supabase');
const { shapeAnswer, shapeAuthor, authorFields } = require('../db/helpers');
const { protect } = require('../middleware/auth');
const { pushNotification, touchUserActivity } = require('../db/features');
const { asyncHandler } = require('../utils/respond');
const { missingFunctionError } = require('../utils/raceFunctions');

/*
 * Every route here that moves an author's points does it inside one SQL
 * function (migration 021), in the same transaction as the row that earned or
 * lost them. They used to be separate statements, two of them writing the
 * balance back from req.userRow -- the copy loaded when the request started --
 * so a concurrent vote could be silently reverted, and a failure between the
 * two writes left a vote or an answer without its points.
 */
async function callAnswerFunction(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) {
    // No racy fallback (decision 0006): a missing function is a loud 503.
    if (error.code === 'PGRST202') throw missingFunctionError(name, error);
    return { data: null, error };
  }
  return { data: Array.isArray(data) ? data[0] : data, error: null };
}

// POST /api/answers/:questionId
router.post('/:questionId', protect, asyncHandler(async (req, res) => {
  const { body } = req.body;
  if (!body) return res.status(400).json({ message: 'Answer body is required' });

  const db = getSupabase();
  const { data: question } = await db
    .from('questions')
    .select('id, author_id, title')
    .eq('id', req.params.questionId)
    .maybeSingle();
  if (!question) return res.status(404).json({ message: 'Question not found' });

  // Insert + the +5 award, in one transaction, against the locked balance.
  const { data: created, error } = await callAnswerFunction(db, 'create_answer', {
    p_question_id: question.id,
    p_author_id: req.user.id,
    p_body: body
  });
  if (error) {
    if (/question not found/i.test(error.message)) {
      return res.status(404).json({ message: 'Question not found' });
    }
    if (/body is required/i.test(error.message)) {
      return res.status(400).json({ message: 'Answer body is required' });
    }
    throw error;
  }

  const { data: answer, error: readErr } = await db
    .from('answers').select('*').eq('id', created.new_answer_id).single();
  if (readErr) throw readErr;

  // Streak and challenge progress only; this write does not touch points.
  try {
    await touchUserActivity(req.user.id, req.userRow, { metric: 'answers' });
  } catch (_) { /* ignore */ }

  if (question.author_id && question.author_id !== req.user.id) {
    pushNotification(question.author_id, {
      type: 'answer',
      title: `${req.user.name} answered your question`,
      body: question.title || body.slice(0, 100),
      link: `/qa/${question.id}`
    }).catch(() => {});
  }

  const { data: author } = await db.from('users').select(authorFields()).eq('id', req.user.id).single();
  res.status(201).json({
    answer: shapeAnswer(answer, { author: shapeAuthor(author), upvotes: [], downvotes: [] }),
    pointsEarned: 5
  });
}, "Could not complete that request"));

// POST /api/answers/:id/vote
router.post('/:id/vote', protect, asyncHandler(async (req, res) => {
  const { type } = req.body;
  const db = getSupabase();
  const answerId = req.params.id;
  const userId = req.user.id;

  /*
   * An allowlist, because the old branch was `if (type === 'up') ... else`.
   * Anything that is not the string 'up' fell into the downvote path: an empty
   * body, a null, a typo, a client sending {vote:'up'} under the wrong key.
   * A curl with no body silently cost the author a point. The SQL function
   * refuses anything else too; this keeps the 400 friendly.
   */
  if (type !== 'up' && type !== 'down') {
    return res.status(400).json({ message: "vote type must be 'up' or 'down'" });
  }

  /*
   * The vote row, the points_applied bookkeeping (016), the one-shot 5-upvote
   * bonus and the author's points are all decided inside cast_answer_vote,
   * under a lock on the answer, and commit together. See migration 021.
   */
  const { data: tally, error } = await callAnswerFunction(db, 'cast_answer_vote', {
    p_answer_id: answerId,
    p_voter_id: userId,
    p_type: type
  });
  if (error) {
    if (/answer not found/i.test(error.message)) {
      return res.status(404).json({ message: 'Answer not found' });
    }
    if (/own answer/i.test(error.message)) {
      return res.status(400).json({ message: 'You cannot vote on your own answer' });
    }
    throw error;
  }

  res.json({ upvotes: tally?.up_count ?? 0, downvotes: tally?.down_count ?? 0 });
}, "Could not complete that request"));

// POST /api/answers/:id/accept
router.post('/:id/accept', protect, asyncHandler(async (req, res) => {
  const db = getSupabase();
  const { data: answer } = await db.from('answers').select('*').eq('id', req.params.id).maybeSingle();
  if (!answer) return res.status(404).json({ message: 'Answer not found' });

  const { data: question } = await db.from('questions').select('*').eq('id', answer.question_id).maybeSingle();
  if (!question) return res.status(404).json({ message: 'Question not found' });
  if (question.author_id !== req.user.id) {
    return res.status(403).json({ message: 'Only question author can accept answers' });
  }

  if (question.accepted_answer_id) {
    await db.from('answers').update({ is_accepted: false }).eq('id', question.accepted_answer_id);
  }

  await db.from('answers').update({ is_accepted: true }).eq('id', answer.id);
  await db.from('questions').update({
    accepted_answer_id: answer.id,
    is_resolved: true
  }).eq('id', question.id);

  if (answer.author_id !== req.user.id) {
    pushNotification(answer.author_id, {
      type: 'accept',
      title: 'Your answer was accepted!',
      body: question.title || 'Great work on Nexora Q&A.',
      link: `/qa/${question.id}`
    }).catch(() => {});
  }

  res.json({ message: 'Answer accepted!' });
}, "Could not complete that request"));


// DELETE /api/answers/:id
router.delete('/:id', protect, asyncHandler(async (req, res) => {
  const db = getSupabase();

  // Points back, accepted pointer cleared and the answer deleted: one transaction.
  const { error } = await callAnswerFunction(db, 'delete_answer', {
    p_answer_id: req.params.id,
    p_author_id: req.user.id
  });
  if (error) {
    if (/answer not found/i.test(error.message)) {
      return res.status(404).json({ message: 'Answer not found' });
    }
    if (/not authorized/i.test(error.message)) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    throw error;
  }

  res.json({ message: 'Answer deleted and points deducted' });
}, "Could not complete that request"));

module.exports = router;
