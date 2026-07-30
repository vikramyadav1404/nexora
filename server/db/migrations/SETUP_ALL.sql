-- ============================================================
-- NEXORA — COMPLETE DATABASE SETUP
--
-- Paste this whole file into the Supabase SQL Editor and press Run.
-- It is safe to run more than once.
--
-- Generated from server/db/migrations/. Files 000, 002 and 003 are
-- deliberately omitted: 001 already creates every table they do.
-- ============================================================


-- ============================================================
-- 001_setup_step_a.sql
-- Core schema: 18 tables, indexes, triggers, RLS
-- ============================================================

-- ============================================================
-- NEXORA STEP A — Full database setup (run once in Supabase)
-- SQL Editor → New query → Paste all → Run
-- Covers: auth, posts, Q&A, friends, follows, interests, gender
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Users ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT DEFAULT '',
  password TEXT NOT NULL,
  avatar TEXT DEFAULT '',
  bio TEXT DEFAULT '',
  language TEXT DEFAULT 'en' CHECK (language IN ('en','hi','es','pt','zh','fr')),

  subscription_plan TEXT DEFAULT 'free' CHECK (subscription_plan IN ('free','bronze','silver','gold')),
  subscription_expires_at TIMESTAMPTZ,
  razorpay_subscription_id TEXT DEFAULT '',

  questions_today INT DEFAULT 0,
  last_question_date TIMESTAMPTZ,
  posts_today INT DEFAULT 0,
  last_post_date TIMESTAMPTZ,

  points INT DEFAULT 0,
  badges TEXT[] DEFAULT '{}',
  total_answers INT DEFAULT 0,
  total_upvotes_received INT DEFAULT 0,

  forgot_password_token TEXT DEFAULT '',
  forgot_password_expire TIMESTAMPTZ,
  forgot_password_count_today INT DEFAULT 0,
  last_forgot_password_date TIMESTAMPTZ,

  language_otp TEXT DEFAULT '',
  language_otp_expire TIMESTAMPTZ,
  pending_language TEXT DEFAULT '',

  email_verified BOOLEAN DEFAULT FALSE,
  email_otp TEXT DEFAULT '',
  email_otp_expire TIMESTAMPTZ,

  is_active BOOLEAN DEFAULT TRUE,
  role TEXT DEFAULT 'user' CHECK (role IN ('user','admin')),

  gender TEXT DEFAULT '' CHECK (gender IN ('', 'male', 'female', 'non-binary', 'prefer-not-to-say')),
  interests TEXT[] DEFAULT '{}',
  onboarding_completed BOOLEAN DEFAULT FALSE,
  is_creator BOOLEAN DEFAULT FALSE,
  creator_interest TEXT DEFAULT '',

  streak_count INT DEFAULT 0,
  last_activity_date DATE,
  challenge_progress JSONB DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Safe upgrades if table already existed without new columns
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS interests TEXT[] DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_creator BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS creator_interest TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS streak_count INT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_activity_date DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS challenge_progress JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_points ON users (points DESC);

-- ─── Friendships ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS friendships (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, friend_id),
  CHECK (user_id <> friend_id)
);

CREATE TABLE IF NOT EXISTS friend_requests (
  from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (from_user_id, to_user_id),
  CHECK (from_user_id <> to_user_id)
);

-- ─── Follows ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS follows (
  follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id <> following_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows (follower_id);

-- ─── Posts ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT DEFAULT '',
  shares INT DEFAULT 0,
  is_public BOOLEAN DEFAULT TRUE,
  interest_tags TEXT[] DEFAULT '{}',
  seed_key TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE posts ADD COLUMN IF NOT EXISTS interest_tags TEXT[] DEFAULT '{}';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS seed_key TEXT DEFAULT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_seed_key ON posts (seed_key) WHERE seed_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts (created_at DESC);

CREATE TABLE IF NOT EXISTS post_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('image','video')),
  url TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS post_likes (
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS post_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Questions & answers ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  views INT DEFAULT 0,
  accepted_answer_id UUID,
  is_resolved BOOLEAN DEFAULT FALSE,
  bounty INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_questions_created ON questions (created_at DESC);

CREATE TABLE IF NOT EXISTS question_votes (
  question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote_type TEXT NOT NULL CHECK (vote_type IN ('up','down')),
  PRIMARY KEY (question_id, user_id)
);

CREATE TABLE IF NOT EXISTS answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  is_accepted BOOLEAN DEFAULT FALSE,
  points_awarded BOOLEAN DEFAULT FALSE,
  bonus_points_awarded BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_answers_question ON answers (question_id);

CREATE TABLE IF NOT EXISTS answer_votes (
  answer_id UUID NOT NULL REFERENCES answers(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote_type TEXT NOT NULL CHECK (vote_type IN ('up','down')),
  PRIMARY KEY (answer_id, user_id)
);

ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_accepted_answer_id_fkey;
ALTER TABLE questions
  ADD CONSTRAINT questions_accepted_answer_id_fkey
  FOREIGN KEY (accepted_answer_id) REFERENCES answers(id) ON DELETE SET NULL;

-- ─── Transactions & point transfers (plans / rewards) ────────
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK (plan IN ('bronze','silver','gold')),
  amount NUMERIC(10,2) NOT NULL,
  currency TEXT DEFAULT 'INR',
  razorpay_order_id TEXT DEFAULT '',
  razorpay_payment_id TEXT DEFAULT '',
  razorpay_signature TEXT DEFAULT '',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','success','failed')),
  invoice_number TEXT DEFAULT '',
  invoice_date TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS point_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  points INT NOT NULL CHECK (points >= 1),
  message TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── updated_at helper ───────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

DROP TRIGGER IF EXISTS posts_updated_at ON posts;
CREATE TRIGGER posts_updated_at BEFORE UPDATE ON posts
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

DROP TRIGGER IF EXISTS questions_updated_at ON questions;
CREATE TRIGGER questions_updated_at BEFORE UPDATE ON questions
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

DROP TRIGGER IF EXISTS answers_updated_at ON answers;
CREATE TRIGGER answers_updated_at BEFORE UPDATE ON answers
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- ─── RLS (Express uses service_role — bypasses RLS) ──────────
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE friend_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE answer_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE point_transfers ENABLE ROW LEVEL SECURITY;

-- ─── Product features (notifications, bookmarks, safety) ───
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  link TEXT DEFAULT '',
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bookmarks (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('post','question')),
  target_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('user','post','question','answer')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT DEFAULT '',
  status TEXT DEFAULT 'open',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

-- Done. Set DEMO_MODE=false and real SUPABASE_* keys in server/.env


-- ============================================================
-- 004_production.sql
-- Audit log table + production indexes
-- ============================================================

-- ============================================================
-- Nexora production extras (run in Supabase SQL Editor if needed)
-- Safe to re-run (IF NOT EXISTS / additive)
-- ============================================================

-- Reports admin fields
ALTER TABLE reports ADD COLUMN IF NOT EXISTS admin_note TEXT DEFAULT '';
ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- Audit log (optional ops)
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  meta JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);

-- Storage: create buckets in Dashboard → Storage
--   avatars (public)
--   posts (public)
-- Or set USE_SUPABASE_STORAGE=true and POST /api/admin is not required —
-- server utils/storage.js can create buckets with service_role.


-- ============================================================
-- 005_hardening.sql
-- Atomic point transfers, durable rate limits, payment indexes
-- ============================================================

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


-- ============================================================
-- 006_feed.sql
-- Feed ranking + stable cursor pagination
-- ============================================================

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


-- ============================================================
-- 007_search.sql
-- Full-text search, trigram matching, realtime notifications
-- ============================================================

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
