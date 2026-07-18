-- ============================================================
-- Nexora production extras (run in Supabase SQL Editor if needed)
-- Safe to re-run (IF NOT EXISTS / additive)
-- ============================================================

-- Reports admin fields
ALTER TABLE reports ADD COLUMN IF NOT EXISTS admin_note TEXT DEFAULT '';
ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- Audit log (optional ops)
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  meta JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);

-- Storage: create buckets in Dashboard → Storage
--   avatars (public)
--   posts (public)
-- Or set USE_SUPABASE_STORAGE=true and POST /api/admin is not required —
-- server utils/storage.js can create buckets with service_role.
