-- ============================================================
-- NEXORA — apply every outstanding migration
-- ============================================================
--
-- Paste this whole file into the Supabase SQL Editor and press Run.
--
-- A live check of the database found 000-004, 008 and 009 already applied, and
-- these four not. The app runs without them, but quietly degraded:
--
--   005  rate limiting FAILS OPEN, so the limiter is effectively off.
--        Points transfer falls back to a non-atomic JS path that can
--        double-spend under concurrency.
--   006  the feed falls back to plain recency -- no personalised ranking.
--   007  search falls back to ILIKE -- no relevance ranking, no index.
--   010  two-factor authentication has nowhere to store anything.
--
--   005 matters most, and it matters most BECAUSE of 010: the second factor is
--   six digits, and an IP-keyed limiter that fails open is not much of a wall.
--   010 carries its own per-account lockout for exactly this reason, but the two
--   are meant to work together.
--
-- Every statement is idempotent -- IF NOT EXISTS, or CREATE OR REPLACE. Running
-- this twice is safe, and running it when some parts are already applied is
-- safe.
-- ============================================================



-- ############################################################
-- 005_hardening.sql
-- ############################################################

-- ============================================================
-- NEXORA 005 — security & correctness hardening
-- Run once in the Supabase SQL editor, after 004_production.sql.
-- Safe to re-run.
-- ============================================================

-- Mirrors computeBadges() in server/db/helpers.js. Kept in SQL so the transfer
-- stays a single statement — if you change the thresholds, change both.
CREATE OR REPLACE FUNCTION compute_badges(p_points INT, p_answers INT)
RETURNS TEXT[]
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v TEXT[] := '{}';
BEGIN
  IF p_points  >= 50  THEN v := array_append(v, 'bronze'); END IF;
  IF p_points  >= 200 THEN v := array_append(v, 'silver'); END IF;
  IF p_points  >= 500 THEN v := array_append(v, 'gold'); END IF;
  IF p_answers >= 10  THEN v := array_append(v, 'contributor'); END IF;
  IF p_answers >= 50  THEN v := array_append(v, 'expert'); END IF;
  RETURN v;
END;
$$;

-- ─── Atomic point transfers ──────────────────────────────────
-- routes/rewards.js used to do a read-modify-write across two `users` rows
-- with no transaction:
--
--   sender.points - pts   -> update sender
--   recipient.points + pts -> update recipient
--
-- Two concurrent transfers both read the same starting balance, so a user with
-- 100 points could send 100 twice. Doing it in one plpgsql function makes it a
-- single transaction, and the ORDER BY id in the lock step gives every caller
-- the same lock ordering so two mutual transfers cannot deadlock.

CREATE OR REPLACE FUNCTION transfer_points(
  p_from_user UUID,
  p_to_user   UUID,
  p_points    INT,
  p_message   TEXT DEFAULT ''
)
RETURNS TABLE (sender_points INT, recipient_points INT, transfer_id UUID)
LANGUAGE plpgsql
AS $$
DECLARE
  v_sender_points    INT;
  v_recipient_points INT;
  v_sender_answers   INT;
  v_recip_answers    INT;
  v_transfer_id      UUID;
BEGIN
  IF p_points < 1 THEN
    RAISE EXCEPTION 'points must be at least 1' USING ERRCODE = 'check_violation';
  END IF;
  IF p_from_user = p_to_user THEN
    RAISE EXCEPTION 'cannot transfer to self' USING ERRCODE = 'check_violation';
  END IF;

  -- Lock both rows up front, always in the same order, then re-read balances.
  PERFORM 1 FROM users
   WHERE id IN (p_from_user, p_to_user)
   ORDER BY id
   FOR UPDATE;

  SELECT points, COALESCE(total_answers, 0) INTO v_sender_points, v_sender_answers
    FROM users WHERE id = p_from_user;
  SELECT points, COALESCE(total_answers, 0) INTO v_recipient_points, v_recip_answers
    FROM users WHERE id = p_to_user;

  IF v_sender_points IS NULL THEN
    RAISE EXCEPTION 'sender not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_recipient_points IS NULL THEN
    RAISE EXCEPTION 'recipient not found' USING ERRCODE = 'no_data_found';
  END IF;

  -- Product rule: keep at least 10 points for yourself.
  IF v_sender_points - p_points < 10 THEN
    RAISE EXCEPTION 'insufficient points' USING ERRCODE = 'check_violation';
  END IF;

  v_sender_points    := v_sender_points - p_points;
  v_recipient_points := v_recipient_points + p_points;

  UPDATE users
     SET points = v_sender_points,
         badges = compute_badges(v_sender_points, v_sender_answers)
   WHERE id = p_from_user;

  UPDATE users
     SET points = v_recipient_points,
         badges = compute_badges(v_recipient_points, v_recip_answers)
   WHERE id = p_to_user;

  INSERT INTO point_transfers (from_user_id, to_user_id, points, message)
  VALUES (p_from_user, p_to_user, p_points, COALESCE(p_message, ''))
  RETURNING id INTO v_transfer_id;

  RETURN QUERY SELECT v_sender_points, v_recipient_points, v_transfer_id;
END;
$$;

-- ─── Durable rate limiting ───────────────────────────────────
-- express-rate-limit's default MemoryStore lives in one lambda's heap. On
-- Vercel each concurrent instance keeps its own counter and a cold start
-- resets it, so the effective auth limit was multiplied by instance count.
CREATE TABLE IF NOT EXISTS rate_limits (
  key         TEXT PRIMARY KEY,
  hits        INT NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits (expires_at);

-- Atomic increment + window roll in one statement.
CREATE OR REPLACE FUNCTION rate_limit_hit(p_key TEXT, p_window_ms INT)
RETURNS TABLE (hits INT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE
  v_now    TIMESTAMPTZ := NOW();
  v_expiry TIMESTAMPTZ := NOW() + make_interval(secs => p_window_ms / 1000.0);
BEGIN
  INSERT INTO rate_limits AS r (key, hits, expires_at)
  VALUES (p_key, 1, v_expiry)
  ON CONFLICT (key) DO UPDATE
    SET hits       = CASE WHEN r.expires_at < v_now THEN 1 ELSE r.hits + 1 END,
        expires_at = CASE WHEN r.expires_at < v_now THEN v_expiry ELSE r.expires_at END
  RETURNING r.hits, r.expires_at INTO hits, expires_at;

  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION rate_limit_reset(p_key TEXT)
RETURNS VOID
LANGUAGE sql
AS $$ DELETE FROM rate_limits WHERE key = p_key; $$;

-- Housekeeping for the cron in routes/cron.js
CREATE OR REPLACE FUNCTION rate_limit_sweep()
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE n INT;
BEGIN
  DELETE FROM rate_limits WHERE expires_at < NOW() - INTERVAL '1 hour';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

-- ─── Payments ────────────────────────────────────────────────
-- The webhook looks transactions up by order id; without this every callback
-- is a sequential scan.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_order
  ON transactions (razorpay_order_id)
  WHERE razorpay_order_id <> '';

CREATE INDEX IF NOT EXISTS idx_transactions_pending
  ON transactions (status, created_at)
  WHERE status = 'pending';


-- ############################################################
-- 006_feed.sql
-- ############################################################

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


-- ############################################################
-- 007_search.sql
-- ############################################################

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


-- ############################################################
-- 010_mfa.sql
-- ############################################################

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
