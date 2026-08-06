-- ============================================================
-- NEXORA 010 — two-factor authentication (TOTP + backup codes)
-- Run after 009_auth_tokens.sql. Safe to re-run.
-- ============================================================
--
-- 009 made a stolen session recoverable. It did nothing about a stolen
-- password, which is the more common failure: reused across sites, phished, or
-- read out of somebody else's breach dump. A password alone still granted a
-- full session.
--
-- Now an account can require a second factor -- a six-digit code from an
-- authenticator app -- before any session is issued at all. Login with MFA on
-- returns a token typed 'mfa_pending', which middleware/auth.js has rejected
-- since 009. It proves the password was correct and buys nothing else.

-- ------------------------------------------------------------
-- Columns on users
-- ------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled         BOOLEAN     NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret          TEXT        DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled_at      TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_step       BIGINT      NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_failed_attempts INT         NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_locked_until    TIMESTAMPTZ;

-- The secret is stored encrypted (AES-256-GCM, key from MFA_SECRET_KEY), not in
-- the clear. Every other credential in this schema is one-way hashed, but a TOTP
-- secret cannot be -- verification needs the original bytes. Encryption is the
-- closest available equivalent: it moves the secret out of reach of anyone
-- holding only a database dump, since the key lives in the environment rather
-- than in Postgres. See server/utils/mfa.js.
COMMENT ON COLUMN users.mfa_secret IS
  'AES-256-GCM ciphertext of the base32 TOTP secret, "v1.iv.tag.data". Never plaintext.';

-- Replay protection. A TOTP code stays valid for its whole 30-second step, so
-- one observed over a shoulder or lifted from a phishing page can be replayed
-- inside that window. Recording the highest step already accepted, and refusing
-- anything at or below it, makes every code strictly single-use.
COMMENT ON COLUMN users.mfa_last_step IS
  'Highest TOTP time-step accepted for this user. Codes at or below it are replays and are refused.';

-- Brute force, handled here rather than left to the rate limiter.
--
-- A six-digit code is one in a million, which sounds like plenty until you
-- notice that an attacker reaching this point already has the password and only
-- needs to be lucky once. The general limiter in middleware/rateLimit.js is not
-- sufficient for that: it is keyed by IP, so a botnet sidesteps it, and it
-- deliberately FAILS OPEN when its store is unavailable -- correct for ordinary
-- traffic, wrong for the last factor guarding an account.
--
-- Counting failures against the account itself is immune to both. It follows the
-- user rather than the connection, and it lives in the same row the login is
-- already reading, so it costs no extra query.
COMMENT ON COLUMN users.mfa_failed_attempts IS
  'Consecutive failed second-factor attempts. Reset to 0 on any success.';
COMMENT ON COLUMN users.mfa_locked_until IS
  'Second factor refuses all codes until this time. Set after repeated failures; independent of the IP rate limiter.';

-- mfa_secret survives a disable so it is never half-set, but only mfa_enabled
-- decides whether login demands a code. Setup writes the secret first and flips
-- the flag only once a code has been verified -- so an interrupted setup leaves
-- an account that still logs in normally, rather than one locked behind a
-- secret its owner never finished scanning.
CREATE INDEX IF NOT EXISTS idx_users_mfa_enabled ON users (mfa_enabled) WHERE mfa_enabled;

-- ------------------------------------------------------------
-- Backup codes
-- ------------------------------------------------------------
-- The failure mode that matters for TOTP is a lost or wiped phone. Without a
-- recovery path the honest answer to a locked-out user is "prove who you are by
-- email", which is exactly the factor MFA was added to stop relying on.
--
-- bcrypt here, where 009 used SHA-256 for refresh tokens. The inputs differ:
-- a refresh token is 32 bytes of CSPRNG output with no guessable structure, so
-- a slow KDF defends nothing. A backup code is short enough to be read aloud and
-- typed, which is a small enough space that the cost factor is the defence.
CREATE TABLE IF NOT EXISTS mfa_backup_codes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN mfa_backup_codes.code_hash IS
  'bcrypt hash of one single-use recovery code. The code is shown once at generation and never again.';
COMMENT ON COLUMN mfa_backup_codes.used_at IS
  'Set when redeemed. Rows are kept rather than deleted so a user can see how many remain.';

-- Verification loads every unused code for one user and compares in turn --
-- bcrypt gives no way to look one up by value.
CREATE INDEX IF NOT EXISTS idx_mfa_backup_codes_user
  ON mfa_backup_codes (user_id)
  WHERE used_at IS NULL;

-- ------------------------------------------------------------
-- Row Level Security
-- ------------------------------------------------------------
-- Same posture as refresh_tokens: RLS on, no policy granted. Express holds the
-- service_role key and is the enforcement layer. Nothing reachable with an anon
-- or authenticated key should ever read these rows -- they are credentials.
ALTER TABLE mfa_backup_codes ENABLE ROW LEVEL SECURITY;
