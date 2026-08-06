const express = require('express');
const router = express.Router();
const { getSupabase } = require('../db/supabase');
const { requireAdmin } = require('../middleware/admin');
const { shapeUser } = require('../db/helpers');
const { sanitizeText } = require('../utils/validate');
const { sendError, asyncHandler } = require('../utils/respond');

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
  const updates = {
    status,
    admin_note: sanitizeText(note, 1000),
    resolved_at: ['resolved', 'dismissed'].includes(status) ? new Date().toISOString() : null
  };
  const { data, error } = await getSupabase()
    .from('reports')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) throw error;
  res.json({ report: data });
}, "Admin action failed"));

// POST /api/admin/users/:id/ban
router.post('/users/:id/ban', requireAdmin, asyncHandler(async (req, res) => {
  const { error } = await getSupabase()
    .from('users')
    .update({ is_active: false })
    .eq('id', req.params.id);
  if (error) throw error;
  res.json({ message: 'User banned (deactivated)' });
}, "Admin action failed"));

// POST /api/admin/users/:id/unban
router.post('/users/:id/unban', requireAdmin, asyncHandler(async (req, res) => {
  const { error } = await getSupabase()
    .from('users')
    .update({ is_active: true })
    .eq('id', req.params.id);
  if (error) throw error;
  res.json({ message: 'User unbanned' });
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
  const { data, error } = await getSupabase()
    .from('users')
    .select('id, name, email, role, is_active, points, created_at')
    .or(`name.ilike.%${q}%,email.ilike.%${q}%`)
    .limit(20);
  if (error) throw error;
  res.json({ users: (data || []).map(u => shapeUser(u)) });
}, "Admin action failed"));

module.exports = router;
