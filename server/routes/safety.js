const express = require('express');
const router = express.Router();
const { getSupabase } = require('../db/supabase');
const { protect } = require('../middleware/auth');
const { requireVerifiedEmail } = require('../middleware/requireVerifiedEmail');
const { shapePerson } = require('../db/helpers');
const { writeLimiter } = require('../middleware/rateLimit');
const { sanitizeText } = require('../utils/validate');
const { sendError, asyncHandler } = require('../utils/respond');

// POST /api/blocks/:id
router.post('/blocks/:id', protect, asyncHandler(async (req, res) => {
  const blockedId = req.params.id;
  if (blockedId === req.user.id) {
    return res.status(400).json({ message: 'Cannot block yourself' });
  }

  const db = getSupabase();
  const { data: target } = await db.from('users').select('id').eq('id', blockedId).maybeSingle();
  if (!target) return res.status(404).json({ message: 'User not found' });

  const { error } = await db.from('blocks').upsert({
    blocker_id: req.user.id,
    blocked_id: blockedId
  }, { onConflict: 'blocker_id,blocked_id' });

  if (error) throw error;

  // Also remove follow relationships either way
  await db.from('follows').delete().eq('follower_id', req.user.id).eq('following_id', blockedId);
  await db.from('follows').delete().eq('follower_id', blockedId).eq('following_id', req.user.id);

  res.json({ message: 'User blocked', blocked: true });
}, "Could not complete that request"));

// DELETE /api/blocks/:id
router.delete('/blocks/:id', protect, asyncHandler(async (req, res) => {
  await getSupabase()
    .from('blocks')
    .delete()
    .eq('blocker_id', req.user.id)
    .eq('blocked_id', req.params.id);
  res.json({ message: 'User unblocked', blocked: false });
}, "Could not complete that request"));

// GET /api/blocks
router.get('/blocks', protect, asyncHandler(async (req, res) => {
  const db = getSupabase();
  const { data: rows, error } = await db
    .from('blocks')
    .select('blocked_id')
    .eq('blocker_id', req.user.id);

  if (error) throw error;
  const ids = (rows || []).map(r => r.blocked_id);
  if (!ids.length) return res.json({ blocks: [] });

  const { data: users } = await db.from('users').select('*').in('id', ids);
  // The people you blocked are still other people -- no contact details.
  res.json({ blocks: (users || []).map(shapePerson) });
}, "Could not complete that request"));

// POST /api/reports
router.post('/reports', protect, writeLimiter, requireVerifiedEmail, asyncHandler(async (req, res) => {
  const { targetType, targetId, reason, details } = req.body;
  if (!targetType || !targetId || !reason) {
    return res.status(400).json({ message: 'targetType, targetId, and reason required' });
  }
  const allowed = ['user', 'post', 'question', 'answer'];
  if (!allowed.includes(targetType)) {
    return res.status(400).json({ message: 'Invalid targetType' });
  }

  const { error } = await getSupabase().from('reports').insert({
    reporter_id: req.user.id,
    target_type: targetType,
    target_id: String(targetId),
    reason: sanitizeText(reason, 200),
    details: sanitizeText(details, 2000),
    status: 'open'
  });

  if (error) throw error;
  res.status(201).json({ message: 'Report submitted. Our team will review it.' });
}, "Could not complete that request"));

module.exports = router;
