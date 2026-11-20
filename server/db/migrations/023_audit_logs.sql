-- ============================================================
-- NEXORA 023 — an append-only audit log, written by the database
-- Run after 010_mfa.sql and 012_production_remainder.sql. Safe to re-run.
-- ============================================================
--
-- audit_logs was declared in 004_production.sql and never applied; nothing
-- wrote to it. This creates it and fills it from triggers, not from route
-- code, for one reason: a log that each route has to remember to write is a
-- log with gaps. A trigger fires on every path that changes the row --
-- routes, cron, a hand-run SQL fix -- in the same transaction as the change,
-- so the entry exists exactly when the change does.
--
-- What is recorded
-- ----------------
--   points.transfer        a row in point_transfers (actor = sender)
--   mfa.enabled/disabled   users.mfa_enabled changed
--   password.changed       users.password changed (the hash is never copied)
--   email.changed          users.email changed (neither address is copied)
--   role.changed           users.role changed (from, to)
--   account.deactivated /
--   account.reactivated    users.is_active changed
--   subscription.changed   users.subscription_plan changed (from, to)
--   report.updated         reports.status or admin_note changed
--
-- Who did it
-- ----------
-- A trigger sees the row, not the HTTP request, and the API connects as one
-- service role. So the actor is recorded when the change goes through a
-- function that knows it and sets `app.actor_id` for its own transaction:
-- transfer_points (the sender is on the row), and the two admin functions
-- below, which the admin routes now call. Other changes record the subject
-- (whose row changed) with actor_id NULL, meaning "not attributed", never
-- guessed.
--
-- Append-only
-- -----------
-- UPDATE, DELETE and TRUNCATE on audit_logs raise, for every role that does
-- not disable triggers. There are no foreign keys, deliberately: an FK with
-- ON DELETE SET NULL is an UPDATE, which would make deleting a user fail, and
-- the record should outlive the account it describes anyway. RLS is on with
-- no policies, so only the service role can read it.
--
-- Safety
-- ------
-- A trigger that names a column the table does not have breaks every UPDATE
-- of that table. The first block below checks each column the triggers read
-- and aborts the whole migration -- one transaction -- if any is missing,
-- instead of installing a trigger that would take down profile saves, votes
-- and logins.
--
-- What this touches: creates audit_logs (new, empty), three triggers, two
-- admin functions. No existing row is changed.

BEGIN;

DO $guard$
DECLARE
  missing TEXT;
BEGIN
  SELECT string_agg(t || '.' || c, ', ') INTO missing
    FROM (VALUES
      ('users', 'mfa_enabled'), ('users', 'password'), ('users', 'email'),
      ('users', 'role'), ('users', 'is_active'), ('users', 'subscription_plan'),
      ('point_transfers', 'from_user_id'), ('point_transfers', 'to_user_id'),
      ('point_transfers', 'points'),
      ('reports', 'status'), ('reports', 'admin_note'), ('reports', 'resolved_at')
    ) AS need(t, c)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns ic
      WHERE ic.table_schema = current_schema() AND ic.table_name = need.t AND ic.column_name = need.c
   );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'audit triggers need columns that are missing: %. Apply 010 and 012 first.', missing;
  END IF;
END
$guard$;

-- ------------------------------------------------------------
-- The table
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id   UUID,
  action     TEXT NOT NULL,
  meta       JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS subject_id UUID;
-- 004's definition had an FK on actor_id; drop it if that ever got applied.
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_actor_id_fkey;

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_subject ON audit_logs (subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor   ON audit_logs (actor_id, created_at DESC);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION audit_logs_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_no_change ON audit_logs;
CREATE TRIGGER audit_logs_no_change
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

DROP TRIGGER IF EXISTS audit_logs_no_truncate ON audit_logs;
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_append_only();

-- The actor a function declared for this transaction, or NULL.
CREATE OR REPLACE FUNCTION audit_actor()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.actor_id', true), '')::uuid;
$$;

-- ------------------------------------------------------------
-- What the triggers record
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_point_transfer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO audit_logs (actor_id, subject_id, action, meta)
  VALUES (NEW.from_user_id, NEW.to_user_id, 'points.transfer',
          jsonb_build_object('points', NEW.points, 'transfer_id', NEW.id));
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS audit_point_transfers ON point_transfers;
CREATE TRIGGER audit_point_transfers
  AFTER INSERT ON point_transfers
  FOR EACH ROW EXECUTE FUNCTION audit_point_transfer();

CREATE OR REPLACE FUNCTION audit_user_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_actor UUID := audit_actor();
BEGIN
  IF NEW.mfa_enabled IS DISTINCT FROM OLD.mfa_enabled THEN
    INSERT INTO audit_logs (actor_id, subject_id, action)
    VALUES (v_actor, NEW.id, CASE WHEN NEW.mfa_enabled THEN 'mfa.enabled' ELSE 'mfa.disabled' END);
  END IF;
  IF NEW.password IS DISTINCT FROM OLD.password THEN
    INSERT INTO audit_logs (actor_id, subject_id, action) VALUES (v_actor, NEW.id, 'password.changed');
  END IF;
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    INSERT INTO audit_logs (actor_id, subject_id, action) VALUES (v_actor, NEW.id, 'email.changed');
  END IF;
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    INSERT INTO audit_logs (actor_id, subject_id, action, meta)
    VALUES (v_actor, NEW.id, 'role.changed', jsonb_build_object('from', OLD.role, 'to', NEW.role));
  END IF;
  IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    INSERT INTO audit_logs (actor_id, subject_id, action)
    VALUES (v_actor, NEW.id,
            CASE WHEN NEW.is_active THEN 'account.reactivated' ELSE 'account.deactivated' END);
  END IF;
  IF NEW.subscription_plan IS DISTINCT FROM OLD.subscription_plan THEN
    INSERT INTO audit_logs (actor_id, subject_id, action, meta)
    VALUES (v_actor, NEW.id, 'subscription.changed',
            jsonb_build_object('from', OLD.subscription_plan, 'to', NEW.subscription_plan));
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS audit_users ON users;
CREATE TRIGGER audit_users
  AFTER UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION audit_user_change();

CREATE OR REPLACE FUNCTION audit_report_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.admin_note IS DISTINCT FROM OLD.admin_note THEN
    INSERT INTO audit_logs (actor_id, subject_id, action, meta)
    VALUES (audit_actor(), NEW.reporter_id, 'report.updated',
            jsonb_build_object('report_id', NEW.id, 'from', OLD.status, 'to', NEW.status,
                               'note_changed', NEW.admin_note IS DISTINCT FROM OLD.admin_note));
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS audit_reports ON reports;
CREATE TRIGGER audit_reports
  AFTER UPDATE ON reports
  FOR EACH ROW EXECUTE FUNCTION audit_report_change();

-- ------------------------------------------------------------
-- Admin actions, attributed
-- ------------------------------------------------------------
-- The admin routes call these instead of updating rows directly, so the
-- trigger above can record which admin acted. Each re-checks the role in
-- SQL as well: the route's requireAdmin is the gate, this is the floor.
-- set_config(..., true) is local to this transaction, so the actor cannot
-- leak to another request sharing the connection.

CREATE OR REPLACE FUNCTION admin_set_user_active(
  p_actor  UUID,
  p_user   UUID,
  p_active BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1 FROM users u WHERE u.id = p_actor AND u.role = 'admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.actor_id', p_actor::text, true);
  UPDATE users u SET is_active = p_active WHERE u.id = p_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user not found' USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;

-- p_note NULL means "leave the note as it is"; '' clears it. Same contract as
-- the route's "only write admin_note when a note was sent".
CREATE OR REPLACE FUNCTION admin_update_report(
  p_actor  UUID,
  p_report UUID,
  p_status TEXT,
  p_note   TEXT DEFAULT NULL
)
RETURNS SETOF reports
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('open', 'reviewing', 'resolved', 'dismissed') THEN
    RAISE EXCEPTION 'invalid status' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM users u WHERE u.id = p_actor AND u.role = 'admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.actor_id', p_actor::text, true);
  RETURN QUERY
    UPDATE reports r
       SET status = p_status,
           resolved_at = CASE WHEN p_status IN ('resolved', 'dismissed') THEN now() ELSE NULL END,
           admin_note = COALESCE(p_note, r.admin_note)
     WHERE r.id = p_report
    RETURNING r.*;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'report not found' USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;

COMMIT;

-- ============================================================
-- Reversibility
-- ============================================================
-- Nothing existing is changed. To undo: drop the triggers audit_users,
-- audit_reports and audit_point_transfers and the two admin_* functions, and
-- redeploy the admin routes from before this change. Keep audit_logs itself
-- unless the record is genuinely unwanted; it is the only copy.
