-- ============================================================
-- NEXORA 022 — search pages past 50, and a typo alone finds something
-- Run after 007_search.sql. Safe to re-run.
-- ============================================================
--
-- Two limits of 007's search_questions / search_posts, both recorded in the
-- README as open.
--
-- 1. No paging. Both ended in LIMIT 50 with no cursor, so result 51 was
--    unreachable. The feed's (created_at, id) keyset does not apply, because
--    results are ordered by rank, not time. But rank is a deterministic
--    function of (query, row), so the order key itself can be the keyset:
--
--        (rank, created_at, id)   -- all DESC
--
--    The next page is every row strictly after the last one shown on that
--    key. Ties on rank (common: identical posts rank identically) are broken
--    by created_at then id, so the order is total and nothing repeats or
--    disappears between pages.
--
-- 2. A query that is only a typo found nothing. 007 matched typos with
--    `title % query`, which compares trigrams of the WHOLE title with the
--    query. A one-word typo against a sentence never reaches the 0.3
--    threshold: on Postgres 16, 'javscript' vs 'How do closures work in
--    JavaScript?' has similarity 0.216. word_similarity compares the query
--    with the best-matching part of the text instead -- 0.615 there, over the
--    0.6 default threshold of `<%`. Unrelated words still score 0.
--
-- The signature gains three optional cursor parameters. A new parameter list
-- is a new function to Postgres, and leaving the old one beside it would make
-- PostgREST calls with (p_query, p_limit) ambiguous, so each old function is
-- dropped and recreated -- inside one transaction, so there is no moment
-- without it. Callers passing only (p_query, p_limit) get exactly what they got
-- before, plus the id tie-break. search_people is unchanged.
--
-- What this touches: two function definitions and one new index
-- (idx_questions_title_trgm, so the title typo match can use an index like the
-- posts one already does). No table, column or row.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_questions_title_trgm ON questions USING GIN (title gin_trgm_ops);

DROP FUNCTION IF EXISTS search_questions(TEXT, INT);

CREATE OR REPLACE FUNCTION search_questions(
  p_query       TEXT,
  p_limit       INT DEFAULT 10,
  p_cursor_rank REAL DEFAULT NULL,
  p_cursor_ts   TIMESTAMPTZ DEFAULT NULL,
  p_cursor_id   UUID DEFAULT NULL
)
RETURNS TABLE (
  id UUID, author_id UUID, title TEXT, body TEXT, tags TEXT[], views INT,
  accepted_answer_id UUID, is_resolved BOOLEAN, bounty INT,
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, rank REAL
)
LANGUAGE sql STABLE
AS $$
  WITH scored AS (
    SELECT q.id, q.author_id, q.title, q.body, q.tags, q.views,
           q.accepted_answer_id, q.is_resolved, q.bounty,
           q.created_at, q.updated_at,
           (ts_rank(q.search_vector, websearch_to_tsquery('english', p_query))
             + word_similarity(p_query, q.title))::REAL AS rank
      FROM questions q
     WHERE q.search_vector @@ websearch_to_tsquery('english', p_query)
        OR p_query <% q.title
  )
  SELECT s.id, s.author_id, s.title, s.body, s.tags, s.views,
         s.accepted_answer_id, s.is_resolved, s.bounty,
         s.created_at, s.updated_at, s.rank
    FROM scored s
   WHERE p_cursor_id IS NULL
      OR (s.rank, s.created_at, s.id) < (p_cursor_rank, p_cursor_ts, p_cursor_id)
   ORDER BY s.rank DESC, s.created_at DESC, s.id DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 50);
$$;

DROP FUNCTION IF EXISTS search_posts(TEXT, INT);

CREATE OR REPLACE FUNCTION search_posts(
  p_query       TEXT,
  p_limit       INT DEFAULT 10,
  p_cursor_rank REAL DEFAULT NULL,
  p_cursor_ts   TIMESTAMPTZ DEFAULT NULL,
  p_cursor_id   UUID DEFAULT NULL
)
RETURNS TABLE (
  id UUID, author_id UUID, content TEXT, shares INT, is_public BOOLEAN,
  interest_tags TEXT[], seed_key TEXT,
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, rank REAL
)
LANGUAGE sql STABLE
AS $$
  WITH scored AS (
    SELECT p.id, p.author_id, p.content, p.shares, p.is_public,
           p.interest_tags, p.seed_key, p.created_at, p.updated_at,
           (ts_rank(p.search_vector, websearch_to_tsquery('english', p_query))
             + word_similarity(p_query, p.content))::REAL AS rank
      FROM posts p
     WHERE p.is_public = TRUE
       AND (p.search_vector @@ websearch_to_tsquery('english', p_query)
            OR p_query <% p.content)
  )
  SELECT s.id, s.author_id, s.content, s.shares, s.is_public,
         s.interest_tags, s.seed_key, s.created_at, s.updated_at, s.rank
    FROM scored s
   WHERE p_cursor_id IS NULL
      OR (s.rank, s.created_at, s.id) < (p_cursor_rank, p_cursor_ts, p_cursor_id)
   ORDER BY s.rank DESC, s.created_at DESC, s.id DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 50);
$$;

COMMIT;

-- ============================================================
-- Reversibility
-- ============================================================
-- No data changes. To undo, inside one transaction: drop the two functions by
-- their new signatures, re-run the search_questions and search_posts blocks
-- from 007_search.sql, and optionally drop idx_questions_title_trgm.
