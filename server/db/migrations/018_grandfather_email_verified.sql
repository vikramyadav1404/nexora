-- ============================================================
-- NEXORA 018 — grandfather existing accounts as email-verified
-- Run after 017_media_paths.sql. Safe to re-run (see the cutoff).
-- ============================================================
--
-- users.email_verified has existed since registration was written and has never
-- been enforced anywhere. Grepping every route and middleware finds exactly one
-- consumer: the weekly digest filter in routes/cron.js. Nothing else has ever
-- consulted it.
--
-- So the flag is currently decorative, and the numbers say so: 29 accounts, 1
-- verified, 28 not, all 29 active. Turning it into a gate without dealing with
-- that first would lock out 96% of the user base -- an outage, not a fix.
--
-- These 28 registered when the flag meant nothing. Treating them as suspicious
-- now would punish them for an omission that was ours, so they are grandfathered
-- rather than made to re-verify an address they have been using.
--
-- ------------------------------------------------------------
-- The cutoff, and why this migration would be dangerous without it
-- ------------------------------------------------------------
-- The obvious form of this statement is:
--
--   UPDATE users SET email_verified = true WHERE email_verified = false;
--
-- and it is a trap. Re-run in a month -- by a rebuild, a migration runner, or
-- somebody being thorough -- it would grandfather every account created in the
-- meantime, silently switching the gate off for exactly the accounts it exists
-- to catch. Nothing would fail; the protection would just quietly stop.
--
-- The cutoff below is the wall-clock moment this file was written. The newest
-- account at that point was created 2026-08-06T15:15:59Z, so every existing row
-- is comfortably inside it and nothing registered afterwards can ever be caught
-- by a re-run.
--
-- That is what makes this idempotent, which every other migration here gets for
-- free and this one does not.

UPDATE users
   SET email_verified = true
 WHERE email_verified IS DISTINCT FROM true
   AND created_at < TIMESTAMPTZ '2026-08-21T17:14:35Z';

-- ------------------------------------------------------------
-- What this deliberately does NOT do
-- ------------------------------------------------------------
-- It does not send anything. Emailing 28 people to ask them to verify an
-- account they already use, for a flag that has never done anything, is noise
-- that would read as a security scare.
--
-- It also does not claim these addresses are confirmed to work. It records that
-- they predate enforcement, which is a different fact -- the honest reading of
-- this column from now on is "verified, or created before verification was
-- required".

-- ============================================================
-- Reversibility
-- ============================================================
-- No column is added, dropped or retyped. To undo, reset the same set:
--
--   UPDATE users SET email_verified = false
--    WHERE created_at < TIMESTAMPTZ '2026-08-21T17:14:35Z';
--
-- Note this would also clear the one account that was genuinely verified before
-- this ran, which is not recoverable from here -- its id is
-- worth recording before reverting.
