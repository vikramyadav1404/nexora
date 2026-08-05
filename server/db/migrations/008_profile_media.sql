-- ============================================================
-- NEXORA 008 — profile media (avatar derivatives + cover image)
-- Run after 007_search.sql. Safe to re-run.
-- ============================================================
--
-- Two problems this fixes.
--
-- First, uploads used to stream through Express: multer buffered the whole file
-- in memory and the API forwarded it to storage. Vercel caps a serverless
-- request body at ~4.5MB, so a large cover image fails before any of our code
-- runs. Uploads now go straight from the browser to Supabase Storage using a
-- signed upload URL, and the API only ever sees the resulting object key.
--
-- Second, we stored the avatar URL and nothing else. With no key we could not
-- delete the previous object when someone changed their picture, so every
-- replacement leaked a file that stayed in the bucket forever. Keeping the key
-- alongside the URL is what makes cleanup possible.
--
-- `avatar` keeps its name. It is referenced by fifteen select lists and by
-- search_people(), and renaming it buys nothing.

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_key       TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_thumb_url TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS cover_url        TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS cover_key        TEXT DEFAULT '';

COMMENT ON COLUMN users.avatar_key       IS 'Storage object key for the full-size avatar. Needed to delete it on replace.';
COMMENT ON COLUMN users.avatar_thumb_url IS '128px square derivative, used in comment and post-card lists.';
COMMENT ON COLUMN users.cover_key        IS 'Storage object key for the cover image.';

-- The orphan sweep in /api/cron/daily looks for rows whose key was cleared but
-- whose object may still exist. Partial index: only rows that actually have a
-- key are ever scanned, which keeps it small.
CREATE INDEX IF NOT EXISTS idx_users_avatar_key
  ON users (avatar_key)
  WHERE avatar_key <> '';

CREATE INDEX IF NOT EXISTS idx_users_cover_key
  ON users (cover_key)
  WHERE cover_key <> '';

-- ============================================================
-- Buckets
-- ============================================================
-- `avatars` already exists. `covers` is new. Both must be created in the
-- Supabase dashboard (Storage → New bucket, Public) with:
--
--   avatars : file size limit 5MB, allowed MIME image/jpeg, image/png, image/webp
--   covers  : file size limit 8MB, allowed MIME image/jpeg, image/png, image/webp
--
-- Those bucket-level limits are the first line of enforcement — a signed upload
-- URL in Supabase Storage cannot carry a Content-Length or Content-Type
-- condition the way an S3 presigned POST policy can. The attach endpoint
-- re-checks real size and magic bytes before persisting anything.
