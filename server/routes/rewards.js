const express = require('express');
const router = express.Router();
const { getSupabase } = require('../db/supabase');
const { computeBadges, shapeAuthor } = require('../db/helpers');
const { protect } = require('../middleware/auth');
const { pushNotification } = require('../db/features');

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
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/rewards/transfer
router.post('/transfer', protect, async (req, res) => {
  try {
    const { toUserId, points, message } = req.body;
    const pts = parseInt(points, 10);

    if (!pts || pts < 1) return res.status(400).json({ message: 'Points must be at least 1' });

    const db = getSupabase();
    const sender = req.userRow;

    if ((sender.points || 0) <= 10) {
      return res.status(403).json({
        message: '❌ You need more than 10 points to transfer points. Keep contributing to earn more!'
      });
    }

    if (pts > sender.points - 10) {
      return res.status(400).json({
        message: `❌ You can transfer at most ${sender.points - 10} points (must keep at least 10 for yourself)`
      });
    }

    if (toUserId === req.user.id) {
      return res.status(400).json({ message: 'You cannot transfer points to yourself' });
    }

    const { data: recipient } = await db.from('users').select('*').eq('id', toUserId).maybeSingle();
    if (!recipient) return res.status(404).json({ message: 'User not found' });

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

    const { data: transfer, error } = await db.from('point_transfers').insert({
      from_user_id: sender.id,
      to_user_id: recipient.id,
      points: pts,
      message: message || ''
    }).select().single();

    if (error) throw error;

    pushNotification(recipient.id, {
      type: 'points',
      title: `${sender.name} sent you ${pts} points`,
      body: message || 'You received points on Nexora.',
      link: '/leaderboard'
    }).catch(() => {});

    res.json({
      message: `✅ Successfully transferred ${pts} points to ${recipient.name}!`,
      senderPoints,
      transfer: {
        _id: transfer.id,
        from: sender.id,
        to: recipient.id,
        points: pts,
        message: message || '',
        createdAt: transfer.created_at
      }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
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
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
