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

  /*
   * Counted in the database, not from the page above.
   *
   * `notifications.filter(...)` only ever saw the newest 50, so a user with 200
   * unread was told 50 -- and once they had more than 50 notifications in
   * total, the older unread ones fell outside the window entirely: never shown,
   * never counted, and cleared by read-all without ever having been seen.
   */
  const { count, error: countErr } = await db
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', req.user.id)
    .eq('read', false);

  if (countErr) throw countErr;
  res.json({ notifications, unread: count || 0 });
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
