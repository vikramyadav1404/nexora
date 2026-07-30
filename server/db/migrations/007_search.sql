-- ============================================================
-- NEXORA 007 — real search + realtime notifications
-- Run after 006_feed.sql. Safe to re-run.
-- ============================================================
--
-- Search was `ILIKE '%q%'` with no ranking: results came back newest-first, so
-- a post that mentions the term in passing outranked an exact title match. And
-- because a leading wildcard cannot use a B-tree index, every search was a
-- sequential scan over the whole table.
--
-- Full-text search gives us relevance (ts_rank) and an index that can actually
-- serve the query; pg_trgm covers typos and partial words that FTS misses.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─── Generated tsvector columns ──────────────────────────────
-- Generated, not trigger-maintained: Postgres keeps them in sync itself, so
-- there is no way for the index to drift from the row.

ALTER TABLE posts ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english', COALESCE(content, ''))) STORED;

ALTER TABLE questions ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    -- Weight A on the title, B on the body: a title hit should outrank a body hit.
    setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(body,  '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_posts_search      ON posts     USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_questions_search  ON questions USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_users_name_trgm   ON users     USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_posts_content_trgm ON posts    USING GIN (content gin_trgm_ops);

-- ─── Ranked search ───────────────────────────────────────────
-- Takes the raw query as a parameter, so there is no filter string to inject
-- into — this closes the same hole 1.2 patched, at the source.

CREATE OR REPLACE FUNCTION search_questions(p_query TEXT, p_limit INT DEFAULT 10)
RETURNS TABLE (
  id UUID, author_id UUID, title TEXT, body TEXT, tags TEXT[], views INT,
  accepted_answer_id UUID, is_resolved BOOLEAN, bounty INT,
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, rank REAL
)
LANGUAGE sql STABLE
AS $$
  SELECT q.id, q.author_id, q.title, q.body, q.tags, q.views,
         q.accepted_answer_id, q.is_resolved, q.bounty,
         q.created_at, q.updated_at,
         ts_rank(q.search_vector, websearch_to_tsquery('english', p_query))
           -- similarity() catches typos and partial words FTS tokenizing misses
           + similarity(q.title, p_query) AS rank
    FROM questions q
   WHERE q.search_vector @@ websearch_to_tsquery('english', p_query)
      OR q.title % p_query
   ORDER BY rank DESC, q.created_at DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 50);
$$;

CREATE OR REPLACE FUNCTION search_posts(p_query TEXT, p_limit INT DEFAULT 10)
RETURNS TABLE (
  id UUID, author_id UUID, content TEXT, shares INT, is_public BOOLEAN,
  interest_tags TEXT[], seed_key TEXT,
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, rank REAL
)
LANGUAGE sql STABLE
AS $$
  SELECT p.id, p.author_id, p.content, p.shares, p.is_public,
         p.interest_tags, p.seed_key, p.created_at, p.updated_at,
         ts_rank(p.search_vector, websearch_to_tsquery('english', p_query)) AS rank
    FROM posts p
   WHERE p.is_public = TRUE
     AND (p.search_vector @@ websearch_to_tsquery('english', p_query)
          OR p.content % p_query)
   ORDER BY rank DESC, p.created_at DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 50);
$$;

CREATE OR REPLACE FUNCTION search_people(p_query TEXT, p_viewer UUID, p_limit INT DEFAULT 10)
RETURNS TABLE (id UUID, name TEXT, avatar TEXT, bio TEXT, points INT, badges TEXT[], rank REAL)
LANGUAGE sql STABLE
AS $$
  SELECT u.id, u.name, u.avatar, u.bio, u.points, u.badges,
         similarity(u.name, p_query) AS rank
    FROM users u
   WHERE u.is_active = TRUE
     AND u.id <> p_viewer
     AND u.name % p_query
     -- Never surface someone the viewer has blocked
     AND NOT EXISTS (
       SELECT 1 FROM blocks b
        WHERE b.blocker_id = p_viewer AND b.blocked_id = u.id
     )
   ORDER BY rank DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 50);
$$;

-- ─── Realtime notifications ──────────────────────────────────
-- The unread badge only refreshed on route change. Publishing this table lets
-- the client subscribe to its own rows over Supabase Realtime.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND tablename = 'notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
  END IF;
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'supabase_realtime publication not found — skipping (self-hosted Postgres?)';
END;
$$;

-- IMPORTANT: Nexora does not use Supabase Auth — it signs its own JWTs with
-- JWT_SECRET. So `auth.uid()` is NULL here and a policy written against it
-- would match nothing.
--
-- Instead the server mints a short-lived Supabase-compatible token
-- (GET /api/auth/realtime-token, signed with SUPABASE_JWT_SECRET) carrying
-- sub = the user id. Supabase Realtime validates that token and exposes the
-- claim to Postgres as request.jwt.claim.sub, which is what we match on.
--
-- Express keeps using the service_role key, which bypasses RLS entirely and is
-- unaffected by this policy.
DROP POLICY IF EXISTS "own notifications are readable" ON notifications;
CREATE POLICY "own notifications are readable"
  ON notifications FOR SELECT
  USING (
    COALESCE(
      current_setting('request.jwt.claim.sub', true),
      (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')
    )::uuid = user_id
  );
