const express = require('express');
const router = express.Router();
const { getSupabase } = require('../db/supabase');
const { protect } = require('../middleware/auth');
const { shapeNotification } = require('../db/features');
const { sendError, asyncHandler } = require('../utils/respond');

// GET /api/notifications
router.get('/', protect, asyncHandler(async (req, res) => {
  const db = getSupabase();
  const { data, error } = await db
    .from('notifications')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) throw error;
  const notifications = (data || []).map(shapeNotification);
  const unread = notifications.filter(n => !n.read).length;
  res.json({ notifications, unread });
}, "Could not load notifications"));

// POST /api/notifications/read-all
router.post('/read-all', protect, asyncHandler(async (req, res) => {
  const { error } = await getSupabase()
    .from('notifications')
    .update({ read: true })
    .eq('user_id', req.user.id)
    .eq('read', false);
  if (error) throw error;
  res.json({ message: 'All marked as read' });
}, "Could not load notifications"));

// POST /api/notifications/:id/read
router.post('/:id/read', protect, asyncHandler(async (req, res) => {
  const { error } = await getSupabase()
    .from('notifications')
    .update({ read: true })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) throw error;
  res.json({ message: 'ok' });
}, "Could not load notifications"));

module.exports = router;
