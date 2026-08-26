-- ============================================================
-- NEXORA 019 — a ledger of which migrations have been applied
-- ============================================================
--
-- This migration exists because of what the absence of it cost.
--
-- Nothing recorded which numbered migration had been applied to which database.
-- Application is a manual paste of runner output into the SQL editor, and the
-- result was silent, non-linear drift: production had migration 014 and 005 but
-- not 015 or 016, while staging had a broken 016. The three functions that make
-- points and quota race-safe were missing or broken in production for months,
-- and there was no way to answer the simple question "what is applied here?"
-- except by probing every function one at a time.
--
-- A ledger makes that question answerable. It does not, by itself, apply
-- anything -- it records what was. The runner (scripts/build-migration-runner.js)
-- appends an INSERT per file it bundles, so from here on every apply writes its
-- own row, and `SELECT version FROM schema_migrations ORDER BY version` is the
-- honest answer to what a database has.
--
-- ------------------------------------------------------------
-- Why the ledger cannot be trusted to be complete for the past
-- ------------------------------------------------------------
-- It starts empty on every existing database, because we genuinely do not know
-- what was applied -- that is the problem it exists to end, not one it can
-- retroactively solve. Do NOT backfill it with guesses. A ledger row must mean
-- "this file was applied and recorded", never "we assume this ran". The boot
-- health check (utils/verify-functions) checks the functions actually exist and
-- run, which is the load-bearing guarantee; the ledger is the audit trail.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,          -- the numeric prefix, e.g. '016'
  name        TEXT NOT NULL,             -- the file name, for humans
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only the operator's own applies write here; no user-facing path touches it.
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;

-- Record this migration. ON CONFLICT so a re-run is a no-op rather than an error
-- -- the same idempotence every migration here is expected to have.
INSERT INTO schema_migrations (version, name)
VALUES ('019', '019_schema_migrations_ledger.sql')
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- Reversibility
-- ============================================================
-- To undo: DROP TABLE IF EXISTS schema_migrations;
-- No function or user data depends on it -- it is a record, not a mechanism.
