-- ============================================================
-- NEXORA 013 — one Razorpay payment can activate one subscription
-- Run after 012_production_remainder.sql. Safe to re-run.
-- ============================================================
--
-- A captured payment can be confirmed twice: once by the browser calling
-- /verify-payment, and once by Razorpay calling the webhook. Both read the
-- transaction, both see status 'pending', and both proceed -- the read and the
-- write are separate statements with nothing between them.
--
-- The damage is bounded. subscription_expires_at is computed as now +
-- PLAN_DAYS, an absolute value rather than an increment, so a double
-- activation does not double anyone's subscription. What it does produce is two
-- invoice emails and a redundant write.
--
-- The real fix is in routes/subscriptions.js, which now updates with
--   .eq('id', ...).eq('status', 'pending')
-- and stops when no row comes back. Whichever caller loses the race matches
-- nothing and returns.
--
-- This index is the second line, not the first. It cannot close the race on its
-- own: both callers write the *same* payment id, and a unique index permits
-- that. What it does catch is the different failure -- one Razorpay payment
-- being recorded against two different transaction rows, which would mean a
-- user paid once and something was activated twice.

-- ------------------------------------------------------------
-- Why partial
-- ------------------------------------------------------------
-- Every transaction is inserted by /create-order before any payment exists, so
-- it starts life with razorpay_payment_id = '' (the column default). A
-- non-partial unique index would therefore reject the second concurrent
-- checkout, breaking normal operation to prevent an edge case.
--
-- The WHERE clause excludes those rows entirely. Checked against the live table
-- before writing this: 6 transactions, all status 'success', all with distinct
-- non-empty payment ids, so the index builds without conflict.
--
-- CONCURRENTLY avoids taking an exclusive lock on a table that is in use.
-- Note it cannot run inside a transaction block -- if your SQL client wraps
-- statements in one, run this file's statement on its own.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_transactions_payment_id
  ON transactions (razorpay_payment_id)
  WHERE razorpay_payment_id <> '';

-- ============================================================
-- Reversibility
-- ============================================================
-- Additive and idempotent. No column is altered, no row is touched, nothing is
-- backfilled. To undo:
--
--   DROP INDEX CONCURRENTLY IF EXISTS idx_transactions_payment_id;
--
-- Dropping it loses nothing -- it stores no data, only a constraint. The
-- application-level fix in subscriptions.js is independent and stays correct
-- with or without this index.
