const express = require('express');
const router = express.Router();
const { getSupabase } = require('../db/supabase');
const { shapeAuthor, computeBadges } = require('../db/helpers');
const { protect } = require('../middleware/auth');
const { pushNotification } = require('../db/features');
const { isValidUuid, sanitizeText } = require('../utils/validate');
const { sendError } = require('../utils/respond');

// Warn once, not per request, when migration 005 has not been applied.
let transferRpcWarned = false;

/**
 * Pre-005 transfer path: read, modify, write, with no transaction.
 *
 * Kept only so the feature still works on a database that has not had
 * 005_hardening.sql applied. It is racy — two concurrent transfers can both
 * read the same balance — which is the whole reason the RPC replaced it.
 */
async function legacyTransfer(db, sender, recipient, pts, message) {
  const senderPoints = sender.points - pts;
  const recipientPoints = (recipient.points || 0) + pts;

  await db.from('users').update({
    points: senderPoints,
    badges: computeBadges(senderPoints, sender.total_answers || 0)
  }).eq('id', sender.id);

  await db.from('users').update({
    points: recipientPoints,
    badges: computeBadges(recipientPoints, recipient.total_answers || 0)
  }).eq('id', recipient.id);

  const { data: row } = await db.from('point_transfers').insert({
    from_user_id: sender.id,
    to_user_id: recipient.id,
    points: pts,
    message: sanitizeText(message, 200)
  }).select().single();

  return {
    sender_points: senderPoints,
    recipient_points: recipientPoints,
    transfer_id: row?.id
  };
}

// GET /api/rewards/leaderboard
router.get('/leaderboard', protect, async (req, res) => {
  try {
    const { data, error } = await getSupabase()
      .from('users')
      .select('id, name, avatar, points, badges, total_answers')
      .eq('is_active', true)
      .order('points', { ascending: false })
      .limit(20);

    if (error) throw error;

    res.json({
      leaderboard: (data || []).map(u => ({
        _id: u.id,
        id: u.id,
        name: u.name,
        avatar: u.avatar,
        points: u.points,
        badges: u.badges || [],
        totalAnswers: u.total_answers || 0
      }))
    });
  } catch (err) { sendError(res, err, req, "Something went wrong on our end"); }
});

// POST /api/rewards/transfer
router.post('/transfer', protect, async (req, res) => {
  try {
    const { toUserId, points, message } = req.body;
    const pts = parseInt(points, 10);

    if (!pts || pts < 1) return res.status(400).json({ message: 'Points must be at least 1' });

    const db = getSupabase();
    const sender = req.userRow;

    if (toUserId === req.user.id) {
      return res.status(400).json({ message: 'You cannot transfer points to yourself' });
    }
    if (!isValidUuid(toUserId)) {
      return res.status(400).json({ message: 'Invalid recipient' });
    }

    // Cheap pre-checks purely so the common failures get a friendly message.
    // They are NOT the enforcement — transfer_points re-checks under a row lock.
    if ((sender.points || 0) <= 10) {
      return res.status(403).json({
        message: 'You need more than 10 points to transfer points. Keep contributing to earn more!'
      });
    }
    if (pts > sender.points - 10) {
      return res.status(400).json({
        message: `You can transfer at most ${sender.points - 10} points (must keep at least 10 for yourself)`
      });
    }

    const { data: recipient } = await db
      .from('users').select('id, name').eq('id', toUserId).maybeSingle();
    if (!recipient) return res.status(404).json({ message: 'User not found' });

    /*
     * One atomic statement. This used to be a read-modify-write across two
     * rows with no transaction, so two concurrent transfers both read the same
     * starting balance and a user could spend the same points twice.
     */
    const { data, error } = await db.rpc('transfer_points', {
      p_from_user: sender.id,
      p_to_user: recipient.id,
      p_points: pts,
      p_message: sanitizeText(message, 200)
    });

    let result = Array.isArray(data) ? data[0] : data;

    if (error) {
      // Losing the race is a client error, not a 500.
      if (/insufficient points/i.test(error.message)) {
        return res.status(400).json({ message: 'You no longer have enough points for that transfer' });
      }
      if (/not found/i.test(error.message)) {
        return res.status(404).json({ message: 'User not found' });
      }
      if (/cannot transfer to self|points must be at least/i.test(error.message)) {
        return res.status(400).json({ message: 'Invalid transfer' });
      }

      // The RPC ships in migration 005. Until that has been run, fall back to
      // the old non-atomic path so transfers keep working — it is racy under
      // concurrency, which is exactly why 005 exists, but a working feature
      // beats a 500. Warned once so it does not go unnoticed.
      if (/Could not find the function|schema cache/i.test(error.message)) {
        if (!transferRpcWarned) {
          transferRpcWarned = true;
          console.warn(
            'transfer_points RPC missing — using the non-atomic fallback, which ' +
            'can double-spend under concurrent requests. Run ' +
            'server/db/migrations/005_hardening.sql to fix.'
          );
        }
        result = await legacyTransfer(db, sender, recipient, pts, message);
      } else {
        throw error;
      }
    }

    const senderPoints = result?.sender_points ?? (sender.points - pts);

    pushNotification(recipient.id, {
      type: 'points',
      title: `${sender.name} sent you ${pts} points`,
      body: message || 'You received points on Nexora.',
      link: '/leaderboard'
    }).catch(() => {});

    res.json({
      message: `Successfully transferred ${pts} points to ${recipient.name}!`,
      senderPoints,
      transfer: {
        _id: result?.transfer_id,
        from: sender.id,
        to: recipient.id,
        points: pts,
        message: message || '',
        createdAt: new Date().toISOString()
      }
    });
  } catch (err) {
    sendError(res, err, req, 'Could not complete that transfer');
  }
});

// GET /api/rewards/transfers
router.get('/transfers', protect, async (req, res) => {
  try {
    const db = getSupabase();
    const userId = req.user.id;

    const { data, error } = await db
      .from('point_transfers')
      .select('*')
      .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;

    const userIds = new Set();
    (data || []).forEach(t => {
      userIds.add(t.from_user_id);
      userIds.add(t.to_user_id);
    });

    const { data: users } = await db
      .from('users')
      .select('id, name, avatar')
      .in('id', [...userIds]);

    const map = Object.fromEntries((users || []).map(u => [u.id, u]));

    res.json({
      transfers: (data || []).map(t => ({
        _id: t.id,
        from: shapeAuthor(map[t.from_user_id] || { id: t.from_user_id }),
        to: shapeAuthor(map[t.to_user_id] || { id: t.to_user_id }),
        points: t.points,
        message: t.message,
        createdAt: t.created_at
      }))
    });
  } catch (err) { sendError(res, err, req, "Something went wrong on our end"); }
});

module.exports = router;
