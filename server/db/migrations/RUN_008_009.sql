-- ============================================================
-- Paste this whole file into the Supabase SQL Editor and press Run.
--
-- Combines migrations 008 and 009 in the correct order. Safe to re-run: every
-- statement is IF NOT EXISTS, so running it twice changes nothing.
--
-- After it succeeds, `cd server && npm start` should print neither the
-- "Profile media columns absent" warning nor the "refresh_tokens table is
-- MISSING" error.
--
-- Verify from psql or the editor with:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name='users' AND column_name LIKE '%avatar%' OR column_name LIKE '%cover%';
--   SELECT to_regclass('public.refresh_tokens');
-- ============================================================


-- ============================================================
-- 008 — profile media (avatar derivatives + cover image)
-- ============================================================
-- `avatar` keeps its name: it is referenced by fifteen select lists and by
-- search_people(), and renaming it buys nothing. These are additions only.

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_key       TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_thumb_url TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS cover_url        TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS cover_key        TEXT DEFAULT '';

COMMENT ON COLUMN users.avatar_key       IS 'Storage object key for the full-size avatar. Needed to delete it on replace.';
COMMENT ON COLUMN users.avatar_thumb_url IS '128px square derivative, used in comment and post-card lists.';
COMMENT ON COLUMN users.cover_key        IS 'Storage object key for the cover image.';

CREATE INDEX IF NOT EXISTS idx_users_avatar_key
  ON users (avatar_key)
  WHERE avatar_key <> '';

CREATE INDEX IF NOT EXISTS idx_users_cover_key
  ON users (cover_key)
  WHERE cover_key <> '';


-- ============================================================
-- 009 — refresh tokens with rotation and reuse detection
-- ============================================================
-- Access tokens now last fifteen minutes and are not revocable -- they expire.
-- Longevity moves here, to an opaque token that can be revoked individually or
-- as a family. Only the SHA-256 of the token is stored; the token itself never
-- touches the database.

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (user_id);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expiry
  ON refresh_tokens (expires_at)
  WHERE revoked_at IS NULL;

-- Consistent with every other table here: RLS on, no policy granted. Express
-- holds the service_role key and is the enforcement layer. These rows are
-- credentials, so anon and authenticated clients should read nothing.
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;


-- ============================================================
-- Confirm it worked
-- ============================================================
SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name = 'users'
       AND column_name IN ('avatar_key','avatar_thumb_url','cover_url','cover_key')
  ) AS profile_media_columns_expected_4,
  to_regclass('public.refresh_tokens') AS refresh_tokens_table;
