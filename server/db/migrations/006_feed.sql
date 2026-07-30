-- ============================================================
-- NEXORA 006 — feed ranking + stable pagination
-- Run after 005_hardening.sql. Safe to re-run.
-- ============================================================
--
-- The old GET /api/posts fetched a 60-row window, scored it in JavaScript,
-- then sliced a page out of it. Three consequences:
--
--   1. `total` was the window size, so the API reported at most 60 posts / 6
--      pages no matter how many existed.
--   2. The window grew with the page number, so the sort order differed between
--      requests — the same post could appear on two pages, or be skipped.
--   3. Ranking only ever saw the newest 60 rows, so an older post matching your
--      interests could never surface.
--
-- Scoring in SQL over the whole table with keyset pagination fixes all three.

CREATE INDEX IF NOT EXISTS idx_posts_keyset
  ON posts (created_at DESC, id DESC)
  WHERE is_public = TRUE;

CREATE INDEX IF NOT EXISTS idx_posts_interest_tags
  ON posts USING GIN (interest_tags);

-- Returns one page of the personalized feed.
--
-- Keyset (cursor) pagination: callers pass the created_at/id of the last row
-- they saw instead of an offset, so inserts at the head of the feed can't shift
-- rows across page boundaries.
--
-- Ranking note: score is a tiebreaker WITHIN a recency band rather than a
-- global sort. Ordering strictly by score would let one followed author's old
-- posts dominate the top of the feed forever, and would make the cursor
-- meaningless. We bucket by day, then rank inside the bucket.
CREATE OR REPLACE FUNCTION feed_for_user(
  p_user_id     UUID,
  p_cursor_ts   TIMESTAMPTZ DEFAULT NULL,
  p_cursor_id   UUID DEFAULT NULL,
  p_limit       INT DEFAULT 10,
  p_personalized BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (
  id            UUID,
  author_id     UUID,
  content       TEXT,
  shares        INT,
  is_public     BOOLEAN,
  interest_tags TEXT[],
  seed_key      TEXT,
  created_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ,
  score         INT
)
LANGUAGE sql
STABLE
AS $$
  WITH me AS (
    SELECT COALESCE(u.interests, '{}') AS interests
      FROM users u WHERE u.id = p_user_id
  ),
  following AS (
    SELECT f.following_id FROM follows f WHERE f.follower_id = p_user_id
  )
  SELECT
    p.id, p.author_id, p.content, p.shares, p.is_public,
    p.interest_tags, p.seed_key, p.created_at, p.updated_at,
    CASE WHEN p_personalized THEN (
        (CASE WHEN p.author_id IN (SELECT following_id FROM following) THEN 50 ELSE 0 END)
      + (CASE WHEN p.interest_tags && (SELECT interests FROM me) THEN 30 ELSE 0 END)
      + (CASE WHEN p.seed_key IS NOT NULL THEN 5 ELSE 0 END)
    ) ELSE 0 END AS score
  FROM posts p
  WHERE p.is_public = TRUE
    -- Keyset: strictly older than the cursor, ties broken by id.
    AND (
      p_cursor_ts IS NULL
      OR p.created_at < p_cursor_ts
      OR (p.created_at = p_cursor_ts AND p.id < p_cursor_id)
    )
  ORDER BY
    date_trunc('day', p.created_at) DESC,
    CASE WHEN p_personalized THEN (
        (CASE WHEN p.author_id IN (SELECT following_id FROM following) THEN 50 ELSE 0 END)
      + (CASE WHEN p.interest_tags && (SELECT interests FROM me) THEN 30 ELSE 0 END)
      + (CASE WHEN p.seed_key IS NOT NULL THEN 5 ELSE 0 END)
    ) ELSE 0 END DESC,
    p.created_at DESC,
    p.id DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 50);
$$;
