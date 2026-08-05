-- ============================================================
-- NEXORA 009 — refresh tokens with rotation and reuse detection
-- Run after 008_profile_media.sql. Safe to re-run.
-- ============================================================
--
-- Access tokens were valid for seven days with no way to revoke them. A token
-- copied off a shared machine, out of a log, or from localStorage kept working
-- for a week, and the only remedy was rotating JWT_SECRET, which logs out every
-- user at once.
--
-- Now the access token lives fifteen minutes and carries no revocation
-- machinery at all -- it simply expires. Longevity moves to an opaque refresh
-- token stored here, which can be revoked individually or as a family.
--
-- Rotation: every use of a refresh token revokes it and issues a replacement,
-- recording the successor in replaced_by. That chain is what makes theft
-- detectable. If a revoked token is ever presented again, either the legitimate
-- client or an attacker is replaying one, and we cannot tell which -- so the
-- whole family is revoked and both parties must log in again.
--
-- Only the SHA-256 of the token is stored. The tokens are 32 bytes of CSPRNG
-- output, so a slow KDF buys nothing against brute force and would add ~250ms
-- of bcrypt to every refresh; bcrypt would also silently truncate at 72 bytes.
-- Backup codes in migration 010 are bcrypt, because those are short and
-- human-typed.

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  replaced_by UUID REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_agent  TEXT DEFAULT '',
  ip          TEXT DEFAULT ''
);

COMMENT ON COLUMN refresh_tokens.token_hash  IS 'SHA-256 of the opaque token. The token itself is never stored.';
COMMENT ON COLUMN refresh_tokens.replaced_by IS 'Successor issued when this token was rotated. Forms the family chain.';
COMMENT ON COLUMN refresh_tokens.revoked_at  IS 'Set on rotation, logout, or family revocation after reuse is detected.';

-- Every refresh does exactly one lookup by hash, so this index is the hot path.
CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens (token_hash);

-- Family revocation and "log out everywhere" both scan by user.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (user_id);

-- The daily cron deletes expired rows; a partial index keeps that cheap without
-- carrying already-revoked rows.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expiry
  ON refresh_tokens (expires_at)
  WHERE revoked_at IS NULL;

-- ============================================================
-- Row Level Security
-- ============================================================
-- Consistent with every other table here: RLS is on, but Express holds the
-- service_role key and is the actual enforcement layer. No policy is granted,
-- so an anon or authenticated client can read nothing -- which is correct.
-- These rows are credentials.
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
