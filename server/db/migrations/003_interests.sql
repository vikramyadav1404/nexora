-- ============================================================
-- Migration: gender, interests, onboarding, follows, post tags
-- Run in Supabase SQL Editor (safe to re-run)
-- ============================================================

-- Gender + interests + onboarding on users
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT DEFAULT ''
  CHECK (gender IN ('', 'male', 'female', 'non-binary', 'prefer-not-to-say'));

ALTER TABLE users ADD COLUMN IF NOT EXISTS interests TEXT[] DEFAULT '{}';

ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT FALSE;

-- Optional: mark system / seed creator accounts
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_creator BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS creator_interest TEXT DEFAULT '';

-- Posts can be tagged with interests for personalized feed
ALTER TABLE posts ADD COLUMN IF NOT EXISTS interest_tags TEXT[] DEFAULT '{}';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS seed_key TEXT DEFAULT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_seed_key ON posts (seed_key) WHERE seed_key IS NOT NULL;

-- Follows (separate from friends)
CREATE TABLE IF NOT EXISTS follows (
  follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id <> following_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows (follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows (following_id);

ALTER TABLE follows ENABLE ROW LEVEL SECURITY;

-- Done. Restart Express after running this.
