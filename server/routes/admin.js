const express = require('express');
const router = express.Router();
const { getSupabase } = require('../db/supabase');
const { requireAdmin } = require('../middleware/admin');
const { shapeUser } = require('../db/helpers');
const { sanitizeText, escapePostgrestValue, isValidUuid } = require('../utils/validate');
const { sendError, asyncHandler } = require('../utils/respond');

/*
 * Admin writes go through SQL functions (migration 023) so the audit trigger
 * can record WHICH admin acted: each function sets app.actor_id for its own
 * transaction before changing the row. A direct update would still be logged,
 * but unattributed.
 */
async function adminRpc(name, args) {
  const { data, error } = await getSupabase().rpc(name, args);
  if (error && error.code === 'PGRST202') {
    const err = new Error(
      `${name} is missing (PGRST202). Run server/db/migrations/023_audit_logs.sql in the Supabase SQL Editor.`
    );
    err.code = 'PGRST202';
    throw err;
  }
  return { data, error };
}

// GET /api/admin/reports
router.get('/reports', requireAdmin, asyncHandler(async (req, res) => {
  const status = req.query.status || 'open';
  const db = getSupabase();
  let q = db.from('reports').select('*').order('created_at', { ascending: false }).limit(100);
  if (status !== 'all') q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw error;
  res.json({ reports: data || [] });
}, "Admin action failed"));

// PATCH /api/admin/reports/:id
router.patch('/reports/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { status, note } = req.body;
  const allowed = ['open', 'reviewing', 'resolved', 'dismissed'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ message: 'Invalid status' });
  }
  /*
   * admin_note is only written when a note was actually sent.
   *
   * It used to be included unconditionally, and sanitizeText(undefined) returns
   * '' -- so a moderator reopening a report with {"status":"reviewing"}, the
   * natural request when you are not editing the note, silently erased whatever
   * the previous moderator had written. There is no history table; that text
   * was simply gone.
   */
  if (!isValidUuid(req.params.id)) return res.status(404).json({ message: 'Report not found' });

  // p_note null = leave the note alone; see migration 023 and the comment above.
  const { data, error } = await adminRpc('admin_update_report', {
    p_actor: req.user.id,
    p_report: req.params.id,
    p_status: status,
    p_note: note !== undefined ? sanitizeText(note, 1000) : null
  });
  if (error) {
    if (/report not found/i.test(error.message)) return res.status(404).json({ message: 'Report not found' });
    throw error;
  }
  res.json({ report: Array.isArray(data) ? data[0] : data });
}, "Admin action failed"));

// POST /api/admin/users/:id/ban
router.post('/users/:id/ban', requireAdmin, asyncHandler(async (req, res) => {
  if (!isValidUuid(req.params.id)) return res.status(404).json({ message: 'User not found' });
  const { error } = await adminRpc('admin_set_user_active', {
    p_actor: req.user.id,
    p_user: req.params.id,
    p_active: false
  });
  if (error) {
    if (/user not found/i.test(error.message)) return res.status(404).json({ message: 'User not found' });
    throw error;
  }
  res.json({ message: 'User banned (deactivated)' });
}, "Admin action failed"));

// POST /api/admin/users/:id/unban
router.post('/users/:id/unban', requireAdmin, asyncHandler(async (req, res) => {
  if (!isValidUuid(req.params.id)) return res.status(404).json({ message: 'User not found' });
  const { error } = await adminRpc('admin_set_user_active', {
    p_actor: req.user.id,
    p_user: req.params.id,
    p_active: true
  });
  if (error) {
    if (/user not found/i.test(error.message)) return res.status(404).json({ message: 'User not found' });
    throw error;
  }
  res.json({ message: 'User unbanned' });
}, "Admin action failed"));

// GET /api/admin/audit?limit=&subject=
// The newest audit entries, optionally for one user. Read-only: audit_logs is
// append-only in the database itself (migration 023).
router.get('/audit', requireAdmin, asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  let q = getSupabase()
    .from('audit_logs')
    .select('id, actor_id, subject_id, action, meta, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (req.query.subject !== undefined) {
    if (!isValidUuid(req.query.subject)) return res.status(400).json({ message: 'subject must be a user id' });
    q = q.eq('subject_id', req.query.subject);
  }
  const { data, error } = await q;
  if (error) throw error;
  res.json({ entries: data || [] });
}, "Admin action failed"));

// GET /api/admin/stats
router.get('/stats', requireAdmin, asyncHandler(async (req, res) => {
  const db = getSupabase();
  const tables = ['users', 'posts', 'questions', 'answers', 'reports', 'notifications'];
  const stats = {};
  for (const t of tables) {
    const { count, error } = await db.from(t).select('*', { count: 'exact', head: true });
    stats[t] = error ? null : count;
  }
  const { count: openReports } = await db
    .from('reports')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'open');
  stats.openReports = openReports;
  res.json({ stats });
}, "Admin action failed"));

// GET /api/admin/users/search
router.get('/users/search', requireAdmin, asyncHandler(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ users: [] });
  /*
   * escapePostgrestValue, like search.js and users.js. Admin-only, so injection
   * severity is low -- but the escaper is also what makes a comma safe, and
   * without it searching "Smith, John" silently truncated the filter term and
   * returned the wrong people. A moderation tool quietly finding the wrong
   * account is its own problem.
   */
  const safeQ = escapePostgrestValue(q);
  const { data, error } = await getSupabase()
    .from('users')
    .select('id, name, email, role, is_active, points, created_at')
    .or(`name.ilike.%${safeQ}%,email.ilike.%${safeQ}%`)
    .limit(20);
  if (error) throw error;

  /*
   * shapeUser here is deliberate, and is the one place contact details are
   * still returned for someone other than the account holder.
   *
   * Moderation needs to identify an account by its email -- it is how a report
   * about "john" gets matched to the right john. The route is behind
   * requireAdmin, and the query above searches on email, so withholding it from
   * the response would leave admins searching for something they cannot see.
   *
   * If you are tightening serialisers, do not "fix" this one by reflex. It is a
   * decision, not an oversight.
   */
  res.json({ users: (data || []).map(u => shapeUser(u)) });
}, "Admin action failed"));

module.exports = router;
