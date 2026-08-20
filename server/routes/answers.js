const express = require('express');
const router = express.Router();
const { getSupabase } = require('../db/supabase');
const {
  computeBadges, shapeAnswer, shapeAuthor, authorFields, getVoteLists
} = require('../db/helpers');
const { protect } = require('../middleware/auth');
const { pushNotification, touchUserActivity } = require('../db/features');
const { sendError, asyncHandler } = require('../utils/respond');
const { applyVotePoints } = require('../utils/votePoints');

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

  const { data: answer, error } = await db.from('answers').insert({
    question_id: question.id,
    author_id: req.user.id,
    body,
    points_awarded: true
  }).select().single();
  if (error) throw error;

  // Award 5 points
  const user = req.userRow;
  const points = (user.points || 0) + 5;
  const totalAnswers = (user.total_answers || 0) + 1;
  const badges = computeBadges(points, totalAnswers);

  await db.from('users').update({
    points,
    total_answers: totalAnswers,
    badges
  }).eq('id', user.id);

  try {
    await touchUserActivity(user.id, { ...user, points, total_answers: totalAnswers }, { metric: 'answers' });
  } catch (_) { /* ignore */ }

  if (question.author_id && question.author_id !== req.user.id) {
    pushNotification(question.author_id, {
      type: 'answer',
      title: `${req.user.name} answered your question`,
      body: question.title || body.slice(0, 100),
      link: `/qa/${question.id}`
    }).catch(() => {});
  }

  const { data: author } = await db.from('users').select(authorFields()).eq('id', user.id).single();
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
   * An allowlist, because the branch below is `if (type === 'up') ... else`.
   * Anything that is not the string 'up' fell into the downvote path: an empty
   * body, a null, a typo, a client sending {vote:'up'} under the wrong key.
   * A curl with no body silently cost the author a point.
   */
  if (type !== 'up' && type !== 'down') {
    return res.status(400).json({ message: "vote type must be 'up' or 'down'" });
  }

  const { data: answer } = await db.from('answers').select('*').eq('id', answerId).maybeSingle();
  if (!answer) return res.status(404).json({ message: 'Answer not found' });
  if (answer.author_id === userId) {
    return res.status(400).json({ message: 'You cannot vote on your own answer' });
  }

  /*
   * Deltas, not a remembered absolute.
   *
   * This used to read the author row, mutate `points` in JavaScript across
   * several awaits, and write the absolute value back -- unconditionally, even
   * on the upvote path where points had not changed. Any concurrent change to
   * that author was silently reverted: posting an answer (+5) while somebody
   * upvoted an older one lost the award, because the vote handler wrote back
   * the balance it read beforehand.
   *
   * applyVotePoints does the arithmetic in one statement against the current
   * row (migration 016), so nothing is carried across an await.
   */
  const { data: existing } = await db
    .from('answer_votes')
    .select('*')
    .eq('answer_id', answerId)
    .eq('user_id', userId)
    .maybeSingle();

  let pointsDelta = 0;
  let upvotesDelta = 0;
  let pointsApplied = false;

  if (type === 'up') {
    if (existing?.vote_type === 'up') {
      // Tapping up again removes the upvote.
      await db.from('answer_votes').delete().eq('answer_id', answerId).eq('user_id', userId);
      upvotesDelta -= 1;
    } else {
      if (existing?.vote_type === 'down') {
        // Undo the downvote as part of the switch -- but only give back a point
        // if one was actually taken. See points_applied below.
        if (existing.points_applied !== false) pointsDelta += 1;
      }
      upvotesDelta += 1;
      await db.from('answer_votes').upsert({
        answer_id: answerId,
        user_id: userId,
        vote_type: 'up',
        points_applied: false
      });
    }
  } else if (existing?.vote_type === 'down') {
    // Tapping down again removes the downvote.
    await db.from('answer_votes').delete().eq('answer_id', answerId).eq('user_id', userId);
    /*
     * Only restore what was taken.
     *
     * The deduction below has a floor at zero, so an author already at zero
     * loses nothing -- and this used to credit +1 regardless, minting points
     * out of a downvote that cost them nothing. N voters downvoting and undoing
     * left the author with N points they never earned, and a new account sits
     * at exactly the floor where it fires.
     *
     * `!== false` rather than `=== true`: a row written before migration 016
     * has no such field, and those votes did deduct.
     */
    if (existing.points_applied !== false) pointsDelta += 1;
  } else {
    if (existing?.vote_type === 'up') upvotesDelta -= 1;

    // Whether the deduction lands depends on the author's balance, which only
    // the database knows. Ask it, and record the answer on the vote row.
    const { data: current } = await db
      .from('users').select('points').eq('id', answer.author_id).maybeSingle();
    pointsApplied = (current?.points || 0) > 0;
    if (pointsApplied) pointsDelta -= 1;

    await db.from('answer_votes').upsert({
      answer_id: answerId,
      user_id: userId,
      vote_type: 'down',
      points_applied: pointsApplied
    });
  }

  // The 5-upvote bonus, still a one-shot flagged on the answer row.
  if (type === 'up' && existing?.vote_type !== 'up') {
    const tally = await getVoteLists(db, 'answer_votes', 'answer_id', answerId);
    if (tally.upvotes.length >= 5 && !answer.bonus_points_awarded) {
      const { data: claimed } = await db.from('answers')
        .update({ bonus_points_awarded: true })
        .eq('id', answerId)
        .eq('bonus_points_awarded', false)
        .select('id');
      // Conditional, so two voters crossing the threshold together award it
      // once rather than twice.
      if (claimed && claimed.length) pointsDelta += 5;
    }
  }

  await applyVotePoints(db, answer.author_id, pointsDelta, upvotesDelta);

  const votes = await getVoteLists(db, 'answer_votes', 'answer_id', answerId);
  res.json({ upvotes: votes.upvotes.length, downvotes: votes.downvotes.length });
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
  const { data: answer } = await db.from('answers').select('*').eq('id', req.params.id).maybeSingle();
  if (!answer) return res.status(404).json({ message: 'Answer not found' });
  if (answer.author_id !== req.user.id) {
    return res.status(403).json({ message: 'Not authorized' });
  }

  const user = req.userRow;
  let points = user.points || 0;
  if (answer.points_awarded) points = Math.max(0, points - 5);
  if (answer.bonus_points_awarded) points = Math.max(0, points - 5);
  const totalAnswers = Math.max(0, (user.total_answers || 0) - 1);
  const badges = computeBadges(points, totalAnswers);

  await db.from('users').update({ points, total_answers: totalAnswers, badges }).eq('id', user.id);

  // Clear accepted if needed
  await db.from('questions')
    .update({ accepted_answer_id: null, is_resolved: false })
    .eq('accepted_answer_id', answer.id);

  await db.from('answers').delete().eq('id', answer.id);

  res.json({ message: 'Answer deleted and points deducted' });
}, "Could not complete that request"));

module.exports = router;
