-- ============================================================
-- Nexora → Supabase Postgres schema
-- Run this in Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- Extensions
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

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_points ON users (points DESC);

-- ─── Friendships (bidirectional rows) ────────────────────────
CREATE TABLE IF NOT EXISTS friendships (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, friend_id),
  CHECK (user_id <> friend_id)
);

-- ─── Friend requests ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS friend_requests (
  from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (from_user_id, to_user_id),
  CHECK (from_user_id <> to_user_id)
);

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_seed_key ON posts (seed_key) WHERE seed_key IS NOT NULL;

-- Follows (interest / creator graph)
CREATE TABLE IF NOT EXISTS follows (
  follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id <> following_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows (follower_id);

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

-- ─── Questions ───────────────────────────────────────────────
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

-- ─── Answers ─────────────────────────────────────────────────
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

-- Optional FK after answers exists
ALTER TABLE questions
  DROP CONSTRAINT IF EXISTS questions_accepted_answer_id_fkey;
ALTER TABLE questions
  ADD CONSTRAINT questions_accepted_answer_id_fkey
  FOREIGN KEY (accepted_answer_id) REFERENCES answers(id) ON DELETE SET NULL;

-- ─── Transactions ────────────────────────────────────────────
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

-- ─── Point transfers ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS point_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  points INT NOT NULL CHECK (points >= 1),
  message TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── updated_at trigger ──────────────────────────────────────
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

DROP TRIGGER IF EXISTS transactions_updated_at ON transactions;
CREATE TRIGGER transactions_updated_at BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- Express uses the service role key (bypasses RLS).
-- Still enable RLS as a safety net if anon key is ever used by mistake.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE friend_requests ENABLE ROW LEVEL SECURITY;
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
ALTER TABLE follows ENABLE ROW LEVEL SECURITY;

-- Done. Use SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in server/.env
