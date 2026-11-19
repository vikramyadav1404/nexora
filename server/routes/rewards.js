const express = require('express');
const router = express.Router();
const { getSupabase } = require('../db/supabase');
const { shapeAuthor, withMediaColumns } = require('../db/helpers');
const { protect } = require('../middleware/auth');
const { requireVerifiedEmail } = require('../middleware/requireVerifiedEmail');
const { pushNotification } = require('../db/features');
const { isValidUuid, sanitizeText } = require('../utils/validate');
const { sendError, asyncHandler } = require('../utils/respond');
const { missingFunctionError } = require('../utils/raceFunctions');

// GET /api/rewards/leaderboard
router.get('/leaderboard', protect, asyncHandler(async (req, res) => {
  const { data, error } = await getSupabase()
    .from('users')
    .select(withMediaColumns('id, name, avatar, points, badges, total_answers'))
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
}, "Something went wrong on our end"));

// POST /api/rewards/transfer
router.post('/transfer', protect, requireVerifiedEmail, asyncHandler(async (req, res) => {
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

  const result = Array.isArray(data) ? data[0] : data;

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

    /*
     * The RPC ships in migration 005. A missing function used to fall back to
     * a read-modify-write across two rows with no transaction — the
     * double-spend this route was rewritten to close. Decision 0006 retired
     * that fallback: a missing function now fails before anything is written.
     */
    if (error.code === 'PGRST202' || /Could not find the function|schema cache/i.test(error.message)) {
      throw missingFunctionError('transfer_points', error);
    }
    throw error;
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
}, 'Could not complete that transfer'));

// GET /api/rewards/transfers
router.get('/transfers', protect, asyncHandler(async (req, res) => {
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
    .select(withMediaColumns('id, name, avatar'))
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
}, "Something went wrong on our end"));

module.exports = router;
