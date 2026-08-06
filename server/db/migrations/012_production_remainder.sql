-- ============================================================
-- NEXORA 012 — the parts of 004 that never reached the database
-- Run after 011_post_media_keys.sql. Safe to re-run.
-- ============================================================
--
-- 004_production.sql was written but never applied. It was only ever bundled
-- into SETUP_ALL.sql, which was a fresh-install file, and the runner the live
-- database was actually built from carried 005, 006, 007 and 010 only. So five
-- things from it are missing, and were missing quietly -- every one is an
-- ALTER or an INDEX, so nothing failed, it was just slower and two columns
-- silently did not exist.
--
-- This re-states those five rather than asking anyone to run 004. 004 also
-- creates audit_logs, which nothing in the codebase writes to; adding an empty
-- table is not something to do by accident, so it is deliberately left out and
-- can be added on purpose later if a writer is ever built.
--
-- Verified missing before writing this: reports and users and posts all exist,
-- audit_logs returns 404, and the three indexes below are absent.

-- ------------------------------------------------------------
-- reports: columns the admin queue reads
-- ------------------------------------------------------------
ALTER TABLE reports ADD COLUMN IF NOT EXISTS admin_note  TEXT DEFAULT '';
ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

COMMENT ON COLUMN reports.admin_note  IS 'Free text an admin leaves when actioning a report.';
COMMENT ON COLUMN reports.resolved_at IS 'When the report left the queue. NULL while open.';

-- ------------------------------------------------------------
-- Indexes
-- ------------------------------------------------------------
-- Every login reads users by email, and register checks it for a duplicate.
-- The column is already UNIQUE, which in Postgres implies an index, so this is
-- belt and braces rather than the hot fix it looks like -- kept because 004
-- declared it and re-stating 004 faithfully is the point of this file.
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- The admin queue filters by status on every load.
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);

-- The feed's fallback path orders by created_at DESC when feed_for_user is
-- unavailable, and several other routes do the same.
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);

-- ============================================================
-- Reversibility
-- ============================================================
-- Every statement is additive and idempotent. The two ALTERs add nullable
-- columns with a constant default, which Postgres 11+ records as metadata
-- without rewriting the table, so neither takes a long lock on the 46 rows in
-- reports or anywhere else.
--
-- To undo:
--   DROP INDEX IF EXISTS idx_posts_created;
--   DROP INDEX IF EXISTS idx_reports_status;
--   DROP INDEX IF EXISTS idx_users_email;
--   ALTER TABLE reports DROP COLUMN IF EXISTS resolved_at;
--   ALTER TABLE reports DROP COLUMN IF EXISTS admin_note;
--
-- Dropping the columns loses any admin notes written in the meantime. Dropping
-- the indexes loses nothing at all.
