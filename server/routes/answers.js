const express = require('express');
const router = express.Router();
const { getSupabase } = require('../db/supabase');
const {
  computeBadges, shapeAnswer, shapeAuthor, authorFields
} = require('../db/helpers');
const { protect } = require('../middleware/auth');
const { pushNotification, touchUserActivity } = require('../db/features');
const { sendError } = require('../utils/respond');

async function getVoteLists(db, answerId) {
  const { data } = await db.from('answer_votes').select('user_id, vote_type').eq('answer_id', answerId);
  const upvotes = [];
  const downvotes = [];
  (data || []).forEach(v => {
    if (v.vote_type === 'up') upvotes.push(v.user_id);
    else downvotes.push(v.user_id);
  });
  return { upvotes, downvotes };
}

// POST /api/answers/:questionId
router.post('/:questionId', protect, async (req, res) => {
  try {
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
  } catch (err) { sendError(res, err, req, "Could not complete that request"); }
});

// POST /api/answers/:id/vote
router.post('/:id/vote', protect, async (req, res) => {
  try {
    const { type } = req.body;
    const db = getSupabase();
    const answerId = req.params.id;
    const userId = req.user.id;

    const { data: answer } = await db.from('answers').select('*').eq('id', answerId).maybeSingle();
    if (!answer) return res.status(404).json({ message: 'Answer not found' });
    if (answer.author_id === userId) {
      return res.status(400).json({ message: 'You cannot vote on your own answer' });
    }

    const { data: author } = await db.from('users').select('*').eq('id', answer.author_id).single();
    let points = author.points || 0;
    let totalUpvotes = author.total_upvotes_received || 0;
    let bonusAwarded = answer.bonus_points_awarded;

    const { data: existing } = await db
      .from('answer_votes')
      .select('*')
      .eq('answer_id', answerId)
      .eq('user_id', userId)
      .maybeSingle();

    if (type === 'up') {
      if (existing?.vote_type === 'up') {
        await db.from('answer_votes').delete().eq('answer_id', answerId).eq('user_id', userId);
        totalUpvotes = Math.max(0, totalUpvotes - 1);
      } else {
        await db.from('answer_votes').upsert({
          answer_id: answerId,
          user_id: userId,
          vote_type: 'up'
        });
        if (existing?.vote_type === 'down') {
          // switching down → up
        } else {
          totalUpvotes += 1;
        }

        const votes = await getVoteLists(db, answerId);
        if (votes.upvotes.length >= 5 && !bonusAwarded) {
          points += 5;
          bonusAwarded = true;
          await db.from('answers').update({ bonus_points_awarded: true }).eq('id', answerId);
        }
      }
    } else {
      if (existing?.vote_type === 'down') {
        await db.from('answer_votes').delete().eq('answer_id', answerId).eq('user_id', userId);
        points = Math.max(0, points + 1); // restore
      } else {
        if (existing?.vote_type === 'up') {
          totalUpvotes = Math.max(0, totalUpvotes - 1);
        }
        await db.from('answer_votes').upsert({
          answer_id: answerId,
          user_id: userId,
          vote_type: 'down'
        });
        points = Math.max(0, points - 1);
      }
    }

    const badges = computeBadges(points, author.total_answers || 0);
    await db.from('users').update({
      points,
      total_upvotes_received: totalUpvotes,
      badges
    }).eq('id', author.id);

    const votes = await getVoteLists(db, answerId);
    res.json({ upvotes: votes.upvotes.length, downvotes: votes.downvotes.length });
  } catch (err) { sendError(res, err, req, "Could not complete that request"); }
});

// POST /api/answers/:id/accept
router.post('/:id/accept', protect, async (req, res) => {
  try {
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
  } catch (err) { sendError(res, err, req, "Could not complete that request"); }
});

// DELETE /api/answers/:id
router.delete('/:id', protect, async (req, res) => {
  try {
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
  } catch (err) { sendError(res, err, req, "Could not complete that request"); }
});

module.exports = router;
