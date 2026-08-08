-- ============================================================
-- NEXORA 015 — daily quotas that cannot be raced
-- Run after 014_trial.sql. Safe to re-run.
-- ============================================================
--
-- The daily question limit is the entire thing the Bronze, Silver and Gold
-- plans sell: free is 1/day, bronze 5, silver 10, gold unlimited. It was
-- enforced as a read-then-write in routes/questions.js -- the row was read once
-- by protect at the start of the request, checked, and written back at the end,
-- with nothing conditional in between.
--
-- Two requests arriving together therefore both read questions_today = 0, both
-- pass the check, and both write 1. Fire N in parallel and a free account gets
-- N questions. The same shape applied to the post limit.
--
-- This is the one place in the codebase where the atomicity discipline lapsed.
-- transfer_points (005), the trial claim (014), payment activation and
-- cancellation all use conditional writes or row locks correctly; the counters
-- did not.
--
-- ------------------------------------------------------------
-- Why a function rather than a conditional UPDATE
-- ------------------------------------------------------------
-- The trial guard works as `.is('trial_used_at', null)` because it is a
-- one-shot transition: there is exactly one winner, ever, and the loser is
-- simply told no. A counter is different -- every request is a legitimate
-- winner until the limit is hit, so a conditional
-- `.eq('questions_today', expected)` update makes concurrent callers fight over
-- a compare-and-swap and forces a retry loop in the route.
--
-- SELECT ... FOR UPDATE serialises them instead: each caller waits its turn,
-- sees the true count, and either takes a slot or is refused. Same approach as
-- transfer_points in 005_hardening.sql.
--
-- ------------------------------------------------------------
-- Date handling
-- ------------------------------------------------------------
-- helpers.js isToday() compares calendar date components in the Node process's
-- local timezone, which is UTC on Vercel. This function uses UTC explicitly so
-- the two agree there. Both would need changing together to move to IST.

CREATE OR REPLACE FUNCTION claim_daily_quota(
  p_user_id UUID,
  p_kind    TEXT,          -- 'question' or 'post'
  p_limit   INT DEFAULT NULL  -- NULL means unlimited
)
RETURNS TABLE (allowed BOOLEAN, used INT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_used      INT;
  v_last      TIMESTAMPTZ;
  v_today     DATE := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF p_kind NOT IN ('question', 'post') THEN
    RAISE EXCEPTION 'unknown quota kind: %', p_kind USING ERRCODE = 'check_violation';
  END IF;

  -- Take the row lock first. Everything after this is serialised per user, so
  -- the read below cannot go stale before the write.
  PERFORM 1 FROM users WHERE id = p_user_id FOR UPDATE;

  IF p_kind = 'question' THEN
    SELECT COALESCE(questions_today, 0), last_question_date
      INTO v_used, v_last FROM users WHERE id = p_user_id;
  ELSE
    SELECT COALESCE(posts_today, 0), last_post_date
      INTO v_used, v_last FROM users WHERE id = p_user_id;
  END IF;

  IF v_used IS NULL THEN
    RAISE EXCEPTION 'user not found' USING ERRCODE = 'no_data_found';
  END IF;

  -- A counter from a previous day is stale, not a used allowance.
  IF v_last IS NULL OR (v_last AT TIME ZONE 'UTC')::date <> v_today THEN
    v_used := 0;
  END IF;

  IF p_limit IS NOT NULL AND v_used >= p_limit THEN
    RETURN QUERY SELECT FALSE, v_used;
    RETURN;
  END IF;

  v_used := v_used + 1;

  IF p_kind = 'question' THEN
    UPDATE users SET questions_today = v_used, last_question_date = now()
     WHERE id = p_user_id;
  ELSE
    UPDATE users SET posts_today = v_used, last_post_date = now()
     WHERE id = p_user_id;
  END IF;

  RETURN QUERY SELECT TRUE, v_used;
END;
$$;

-- ============================================================
-- Reversibility
-- ============================================================
-- Adds one function. No table is altered, no row is touched, no data is
-- backfilled. To undo:
--
--   DROP FUNCTION IF EXISTS claim_daily_quota(UUID, TEXT, INT);
--
-- Dropping it reopens the race. The routes fall back to the old read-then-write
-- path when the function is absent (PGRST202), so the application keeps working
-- either way -- it simply stops being safe under concurrency.
