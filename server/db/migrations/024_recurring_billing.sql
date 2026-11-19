-- ============================================================
-- NEXORA 024 — recurring billing on Razorpay Subscriptions
-- Run after 013_payment_idempotency.sql. Safe to re-run.
-- ============================================================
--
-- Until now a payment bought 30 days and nothing renewed: "subscriptions that
-- silently do not renew", as the README put it. With Razorpay Subscriptions the
-- card is charged each period and Razorpay tells us by webhook. This migration
-- is the database half: where the lifecycle is recorded, and one function that
-- applies a billing event atomically and exactly once.
--
-- The lifecycle (Razorpay's own statuses, stored as they come)
-- ------------------------------------------------------------
--   created / authenticated   checkout started / mandate set; no access yet
--   active                    charged; access runs to the period end + grace
--   pending                   a renewal charge failed and Razorpay is retrying;
--                             access continues through the grace window
--   halted                    retries exhausted: access ends now
--   cancelled / completed     no further charges: access runs to the period end
--   paused                    no change to access already paid for
--
-- Access is still decided where it always was -- users.subscription_plan and
-- subscription_expires_at, read by getActivePlan() -- so nothing else in the app
-- changes. This function is what moves those two columns for recurring plans.
--
-- Webhooks are at-least-once and unordered
-- ----------------------------------------
-- 1. Duplicates: billing_events.event_id is the primary key. The first insert
--    wins; a redelivery inserts nothing and changes nothing.
-- 2. Out of order: the status is applied only if the event is newer than the
--    last one applied (users.subscription_event_at). An old event cannot turn a
--    halted subscription back to active.
-- 3. One payment, one period: a charge extends access only if its payment id is
--    new for that user. The browser's verify call and Razorpay's
--    subscription.charged webhook both report the same first payment; whichever
--    is second records nothing and extends nothing. Checked under the user row
--    lock rather than relying on 013's unique index, which this does not assume
--    is present.
-- 4. The period end only moves forward.
--
-- What this touches: three nullable/defaulted columns on users (catalogue-only
-- in Postgres 11+, no table rewrite), one new table, one new index, one new
-- function. No existing row is changed.

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status      TEXT NOT NULL DEFAULT 'none';
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_current_end TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_event_at    TIMESTAMPTZ;

COMMENT ON COLUMN users.subscription_status IS
  'Razorpay subscription status for a recurring plan, or none. Access is still subscription_plan + subscription_expires_at.';

CREATE INDEX IF NOT EXISTS idx_users_razorpay_subscription
  ON users (razorpay_subscription_id)
  WHERE razorpay_subscription_id <> '';

CREATE TABLE IF NOT EXISTS billing_events (
  event_id                 TEXT PRIMARY KEY,
  event_type               TEXT NOT NULL,
  razorpay_subscription_id TEXT,
  outcome                  TEXT NOT NULL DEFAULT 'received',
  received_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION apply_subscription_event(
  p_event_id        TEXT,
  p_event_type      TEXT,
  p_event_at        TIMESTAMPTZ,
  p_subscription_id TEXT,
  p_status          TEXT,
  p_plan            TEXT,
  p_current_end     TIMESTAMPTZ,
  p_payment_id      TEXT DEFAULT NULL,
  p_amount          NUMERIC DEFAULT NULL,
  p_grace_days      INT DEFAULT 3
)
RETURNS TABLE (outcome TEXT, affected_user UUID, new_plan TEXT, new_expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE
  v_user        UUID;
  v_event_at    TIMESTAMPTZ;
  v_expires     TIMESTAMPTZ;
  v_plan        TEXT;
  v_status      TEXT;
  v_end         TIMESTAMPTZ;
  v_new_payment BOOLEAN := FALSE;
  v_outcome     TEXT;
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN
     ('created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'paused') THEN
    RAISE EXCEPTION 'unknown subscription status %', p_status USING ERRCODE = 'check_violation';
  END IF;
  IF p_plan IS NOT NULL AND p_plan NOT IN ('bronze', 'silver', 'gold') THEN
    RAISE EXCEPTION 'unknown plan %', p_plan USING ERRCODE = 'check_violation';
  END IF;

  -- 1. Exactly once per event id.
  INSERT INTO billing_events (event_id, event_type, razorpay_subscription_id)
  VALUES (p_event_id, p_event_type, p_subscription_id)
  ON CONFLICT (event_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'duplicate'::TEXT, NULL::UUID, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- 2. The subscriber, locked: every event for one user is applied in turn.
  SELECT u.id, u.subscription_event_at, u.subscription_expires_at, u.subscription_plan,
         u.subscription_status, u.subscription_current_end
    INTO v_user, v_event_at, v_expires, v_plan, v_status, v_end
    FROM users u
   WHERE u.razorpay_subscription_id = p_subscription_id
     AND p_subscription_id <> ''
     FOR UPDATE;
  IF NOT FOUND THEN
    UPDATE billing_events b SET outcome = 'unknown_subscription' WHERE b.event_id = p_event_id;
    RETURN QUERY SELECT 'unknown_subscription'::TEXT, NULL::UUID, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- 3. A charge, recorded once per payment id for this user.
  IF p_payment_id IS NOT NULL AND p_payment_id <> '' THEN
    PERFORM 1 FROM transactions t WHERE t.user_id = v_user AND t.razorpay_payment_id = p_payment_id;
    IF NOT FOUND THEN
      INSERT INTO transactions (user_id, plan, amount, razorpay_order_id, razorpay_payment_id,
                                razorpay_signature, status, invoice_number)
      VALUES (v_user, p_plan, COALESCE(p_amount, 0), p_subscription_id, p_payment_id,
              'subscription', 'success', 'INV-' || p_payment_id);
      v_new_payment := TRUE;
    END IF;
  END IF;

  -- 4. The period end only moves forward.
  IF p_current_end IS NOT NULL AND (v_end IS NULL OR p_current_end > v_end) THEN
    v_end := p_current_end;
  END IF;

  -- A new payment buys the period it paid for, plus the grace window that
  -- keeps access through the next renewal's retries.
  IF v_new_payment AND v_end IS NOT NULL THEN
    v_plan := p_plan;
    v_expires := GREATEST(COALESCE(v_expires, now()), v_end + make_interval(days => p_grace_days));
  END IF;

  -- 5. Status, only from an event newer than the last one applied.
  IF p_status IS NOT NULL AND (v_event_at IS NULL OR p_event_at >= v_event_at) THEN
    v_status := p_status;
    v_event_at := p_event_at;
    IF p_status = 'halted' THEN
      -- Retries exhausted: access ends now.
      v_expires := LEAST(COALESCE(v_expires, now()), now());
    ELSIF p_status IN ('cancelled', 'completed') AND v_end IS NOT NULL THEN
      -- No more charges: keep what was paid for, without the grace window.
      v_expires := LEAST(COALESCE(v_expires, v_end), v_end);
    END IF;
    v_outcome := CASE WHEN v_new_payment THEN 'charged' ELSE 'status' END;
  ELSE
    v_outcome := CASE WHEN v_new_payment THEN 'charged_stale_status' ELSE 'stale' END;
  END IF;

  UPDATE users u
     SET subscription_status = v_status,
         subscription_event_at = v_event_at,
         subscription_current_end = v_end,
         subscription_plan = COALESCE(v_plan, u.subscription_plan),
         subscription_expires_at = v_expires
   WHERE u.id = v_user;

  UPDATE billing_events b SET outcome = v_outcome WHERE b.event_id = p_event_id;

  RETURN QUERY SELECT v_outcome, v_user, v_plan, v_expires;
END;
$$;

COMMIT;

-- ============================================================
-- Reversibility
-- ============================================================
-- No existing row is changed. To undo: DROP FUNCTION apply_subscription_event,
-- DROP TABLE billing_events, and drop the three users columns and the index.
-- Recurring routes answer 503 without the function rather than falling back.
