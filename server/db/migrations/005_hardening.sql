-- ============================================================
-- NEXORA 005 — security & correctness hardening
-- Run once in the Supabase SQL editor, after 004_production.sql.
-- Safe to re-run.
-- ============================================================

-- Mirrors computeBadges() in server/db/helpers.js. Kept in SQL so the transfer
-- stays a single statement — if you change the thresholds, change both.
CREATE OR REPLACE FUNCTION compute_badges(p_points INT, p_answers INT)
RETURNS TEXT[]
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v TEXT[] := '{}';
BEGIN
  IF p_points  >= 50  THEN v := array_append(v, 'bronze'); END IF;
  IF p_points  >= 200 THEN v := array_append(v, 'silver'); END IF;
  IF p_points  >= 500 THEN v := array_append(v, 'gold'); END IF;
  IF p_answers >= 10  THEN v := array_append(v, 'contributor'); END IF;
  IF p_answers >= 50  THEN v := array_append(v, 'expert'); END IF;
  RETURN v;
END;
$$;

-- ─── Atomic point transfers ──────────────────────────────────
-- routes/rewards.js used to do a read-modify-write across two `users` rows
-- with no transaction:
--
--   sender.points - pts   -> update sender
--   recipient.points + pts -> update recipient
--
-- Two concurrent transfers both read the same starting balance, so a user with
-- 100 points could send 100 twice. Doing it in one plpgsql function makes it a
-- single transaction, and the ORDER BY id in the lock step gives every caller
-- the same lock ordering so two mutual transfers cannot deadlock.

CREATE OR REPLACE FUNCTION transfer_points(
  p_from_user UUID,
  p_to_user   UUID,
  p_points    INT,
  p_message   TEXT DEFAULT ''
)
RETURNS TABLE (sender_points INT, recipient_points INT, transfer_id UUID)
LANGUAGE plpgsql
AS $$
DECLARE
  v_sender_points    INT;
  v_recipient_points INT;
  v_sender_answers   INT;
  v_recip_answers    INT;
  v_transfer_id      UUID;
BEGIN
  IF p_points < 1 THEN
    RAISE EXCEPTION 'points must be at least 1' USING ERRCODE = 'check_violation';
  END IF;
  IF p_from_user = p_to_user THEN
    RAISE EXCEPTION 'cannot transfer to self' USING ERRCODE = 'check_violation';
  END IF;

  -- Lock both rows up front, always in the same order, then re-read balances.
  PERFORM 1 FROM users
   WHERE id IN (p_from_user, p_to_user)
   ORDER BY id
   FOR UPDATE;

  SELECT points, COALESCE(total_answers, 0) INTO v_sender_points, v_sender_answers
    FROM users WHERE id = p_from_user;
  SELECT points, COALESCE(total_answers, 0) INTO v_recipient_points, v_recip_answers
    FROM users WHERE id = p_to_user;

  IF v_sender_points IS NULL THEN
    RAISE EXCEPTION 'sender not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_recipient_points IS NULL THEN
    RAISE EXCEPTION 'recipient not found' USING ERRCODE = 'no_data_found';
  END IF;

  -- Product rule: keep at least 10 points for yourself.
  IF v_sender_points - p_points < 10 THEN
    RAISE EXCEPTION 'insufficient points' USING ERRCODE = 'check_violation';
  END IF;

  v_sender_points    := v_sender_points - p_points;
  v_recipient_points := v_recipient_points + p_points;

  UPDATE users
     SET points = v_sender_points,
         badges = compute_badges(v_sender_points, v_sender_answers)
   WHERE id = p_from_user;

  UPDATE users
     SET points = v_recipient_points,
         badges = compute_badges(v_recipient_points, v_recip_answers)
   WHERE id = p_to_user;

  INSERT INTO point_transfers (from_user_id, to_user_id, points, message)
  VALUES (p_from_user, p_to_user, p_points, COALESCE(p_message, ''))
  RETURNING id INTO v_transfer_id;

  RETURN QUERY SELECT v_sender_points, v_recipient_points, v_transfer_id;
END;
$$;

-- ─── Durable rate limiting ───────────────────────────────────
-- express-rate-limit's default MemoryStore lives in one lambda's heap. On
-- Vercel each concurrent instance keeps its own counter and a cold start
-- resets it, so the effective auth limit was multiplied by instance count.
CREATE TABLE IF NOT EXISTS rate_limits (
  key         TEXT PRIMARY KEY,
  hits        INT NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits (expires_at);

-- Atomic increment + window roll in one statement.
CREATE OR REPLACE FUNCTION rate_limit_hit(p_key TEXT, p_window_ms INT)
RETURNS TABLE (hits INT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE
  v_now    TIMESTAMPTZ := NOW();
  v_expiry TIMESTAMPTZ := NOW() + make_interval(secs => p_window_ms / 1000.0);
BEGIN
  INSERT INTO rate_limits AS r (key, hits, expires_at)
  VALUES (p_key, 1, v_expiry)
  ON CONFLICT (key) DO UPDATE
    SET hits       = CASE WHEN r.expires_at < v_now THEN 1 ELSE r.hits + 1 END,
        expires_at = CASE WHEN r.expires_at < v_now THEN v_expiry ELSE r.expires_at END
  RETURNING r.hits, r.expires_at INTO hits, expires_at;

  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION rate_limit_reset(p_key TEXT)
RETURNS VOID
LANGUAGE sql
AS $$ DELETE FROM rate_limits WHERE key = p_key; $$;

-- Housekeeping for the cron in routes/cron.js
CREATE OR REPLACE FUNCTION rate_limit_sweep()
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE n INT;
BEGIN
  DELETE FROM rate_limits WHERE expires_at < NOW() - INTERVAL '1 hour';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

-- ─── Payments ────────────────────────────────────────────────
-- The webhook looks transactions up by order id; without this every callback
-- is a sequential scan.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_order
  ON transactions (razorpay_order_id)
  WHERE razorpay_order_id <> '';

CREATE INDEX IF NOT EXISTS idx_transactions_pending
  ON transactions (status, created_at)
  WHERE status = 'pending';
