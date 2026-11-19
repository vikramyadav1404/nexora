-- ============================================================
-- NEXORA 020 — make the feed cursor agree with the feed's sort order
-- Run after 006_feed.sql. Safe to re-run.
-- ============================================================
--
-- What was wrong
-- --------------
-- 006's feed_for_user sorts by
--
--     (day bucket, score, created_at, id)   -- all DESC
--
-- but its cursor only remembered (created_at, id), and the next page was
-- "everything strictly older than the cursor's created_at". Inside a day bucket
-- the order is by score first, so the last row of a page is often NOT the
-- oldest row shown. Every same-day post that sorted after the cursor but was
-- NEWER than it was never returned, on any page.
--
-- Concretely, one day, a viewer who follows author X:
--
--     A  X's post       10:00   score 50
--     B  stranger       11:00   score 0
--     C  stranger       09:00   score 0
--
-- Full order: A, B, C. Page size 1: page one is A, cursor = 10:00. Page two
-- asks for created_at < 10:00 and gets C. B is skipped for good. The more a
-- viewer follows, the more of each day they silently never see.
--
-- The route test could not catch this: the test fake has no feed_for_user, so
-- every feed test exercised the plain-recency fallback, which is consistent
-- with its own cursor. Decision 0004 again — the SQL had only ever run in
-- production. sqlFunctions.contract.test.mjs now runs this function for real.
--
-- The fix
-- -------
-- Keyset on the whole sort key. The next page is every row that sorts strictly
-- after the cursor row:
--
--     (day, score, created_at, id) < (cursor's day, score, created_at, id)
--
-- The cursor's score is not sent by the client. It is recomputed here from the
-- cursor post, for this viewer, with the same expression as every other row,
-- so the comparison is always made under one consistent scoring. That keeps
-- the signature, the return type and the API cursor exactly as they were:
-- CREATE OR REPLACE swaps the body in place, no client or route change is
-- needed, and old cursors held by open tabs keep working.
--
-- When the cursor post is gone
-- ----------------------------
-- If the cursor post was deleted or made private between two page loads, its
-- score cannot be recomputed. The function then returns the cursor's whole day
-- again, plus everything older. That repeats rows the viewer has already been
-- shown; it never skips one. Repeats are harmless — the feed client already
-- de-duplicates by id (pages/Feed.jsx) — while a skip is invisible and
-- permanent. Same choice as the media sweep: prefer the recoverable failure.
--
-- Only public posts are looked up as cursors, the same set the feed returns,
-- so a hand-made cursor naming a private post learns nothing about it.
--
-- What this does NOT touch
-- ------------------------
-- No table, column, index or row. One function body is replaced.

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
  ),
  ranked AS (
    SELECT
      p.id, p.author_id, p.content, p.shares, p.is_public,
      p.interest_tags, p.seed_key, p.created_at, p.updated_at,
      date_trunc('day', p.created_at) AS day_bucket,
      CASE WHEN p_personalized THEN (
          (CASE WHEN p.author_id IN (SELECT following_id FROM following) THEN 50 ELSE 0 END)
        + (CASE WHEN p.interest_tags && (SELECT interests FROM me) THEN 30 ELSE 0 END)
        + (CASE WHEN p.seed_key IS NOT NULL THEN 5 ELSE 0 END)
      ) ELSE 0 END AS score
    FROM posts p
    WHERE p.is_public = TRUE
      -- Nothing from a day after the cursor's day can come next. This bound is
      -- implied by the keyset below; it is here so the scan can stop early.
      AND (
        p_cursor_ts IS NULL
        OR p.created_at < date_trunc('day', p_cursor_ts) + INTERVAL '1 day'
      )
  ),
  cursor_row AS (
    SELECT r.day_bucket, r.score, r.created_at, r.id
      FROM ranked r
     WHERE p_cursor_id IS NOT NULL
       AND r.id = p_cursor_id
  )
  SELECT
    r.id, r.author_id, r.content, r.shares, r.is_public,
    r.interest_tags, r.seed_key, r.created_at, r.updated_at, r.score
  FROM ranked r
  WHERE
    -- First page.
    p_cursor_ts IS NULL
    -- Next page: strictly after the cursor row, on the full sort key.
    OR (
      EXISTS (SELECT 1 FROM cursor_row)
      AND (r.day_bucket, r.score, r.created_at, r.id)
        < (SELECT c.day_bucket, c.score, c.created_at, c.id FROM cursor_row c)
    )
    -- Cursor post gone: the bound in `ranked` already limits this to the
    -- cursor's day and older. Repeats, never skips (see the header).
    OR NOT EXISTS (SELECT 1 FROM cursor_row)
  ORDER BY
    r.day_bucket DESC,
    r.score DESC,
    r.created_at DESC,
    r.id DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 50);
$$;

-- ============================================================
-- Reversibility
-- ============================================================
-- Replaces one function body; no data is read differently or written at all.
-- To undo, re-run the feed_for_user block from 006_feed.sql, which restores
-- the previous (skipping) behaviour. Same signature, so nothing else changes.
