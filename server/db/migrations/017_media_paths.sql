-- ============================================================
-- NEXORA 017 — stored media URLs become proxy paths
-- Run after 016_vote_points.sql. Safe to re-run.
-- ============================================================
--
-- Media URLs were stored as absolute Supabase public URLs:
--
--   https://<ref>.supabase.co/storage/v1/object/public/<bucket>/<key>
--
-- Those are readable by anyone who has ever seen them. No expiry, no relation
-- to the post's is_public flag, and still live after the account is deleted. A
-- public bucket cannot express "only people who can see this post", so the
-- check moved to routes/media.js and the buckets become private.
--
-- This rewrites what is stored to the path that route serves:
--
--   /api/media/<bucket>/<key>
--
-- Relative on purpose. The client reaches the API same-origin through the
-- rewrites in client/vercel.json, which is what allows the media cookie -- an
-- <img> cannot send an Authorization header, so a cookie is the only credential
-- available, and a cross-origin URL would not carry it.
--
-- ------------------------------------------------------------
-- Why a rewrite rather than storing keys
-- ------------------------------------------------------------
-- The keys are already stored separately (avatar_key, cover_key,
-- post_media.storage_key, from migrations 008 and 011). Building the URL at
-- read time from those would also work, and would be tidier.
--
-- It is not done here because shapeUser and shapeAuthor are synchronous and
-- called per row across nearly every route; deriving URLs there is a change to
-- the shape of the whole read path, not to storage. Rewriting the stored value
-- keeps this migration to what it says on the tin.

-- ------------------------------------------------------------
-- The rewrite
-- ------------------------------------------------------------
-- Anchored on the fixed public-object prefix, so a value that is already a
-- proxy path, a data: URI, or an external URL is left alone. That is what makes
-- this safe to run twice.

UPDATE users
   SET avatar = regexp_replace(
         avatar,
         '^https?://[^/]+/storage/v1/object/public/([^/]+)/',
         '/api/media/\1/'
       )
 WHERE avatar ~ '^https?://[^/]+/storage/v1/object/public/';

UPDATE users
   SET avatar_thumb_url = regexp_replace(
         avatar_thumb_url,
         '^https?://[^/]+/storage/v1/object/public/([^/]+)/',
         '/api/media/\1/'
       )
 WHERE avatar_thumb_url ~ '^https?://[^/]+/storage/v1/object/public/';

UPDATE users
   SET cover_url = regexp_replace(
         cover_url,
         '^https?://[^/]+/storage/v1/object/public/([^/]+)/',
         '/api/media/\1/'
       )
 WHERE cover_url ~ '^https?://[^/]+/storage/v1/object/public/';

UPDATE post_media
   SET url = regexp_replace(
         url,
         '^https?://[^/]+/storage/v1/object/public/([^/]+)/',
         '/api/media/\1/'
       )
 WHERE url ~ '^https?://[^/]+/storage/v1/object/public/';

-- ============================================================
-- Reversibility
-- ============================================================
-- No column is added, dropped or retyped; only values change, and only those
-- matching the public-URL prefix. At the time of writing that is one avatar,
-- one avatar thumbnail and one cover -- post_media is empty.
--
-- To undo, put the project URL back in place of the proxy prefix:
--
--   UPDATE users SET avatar = regexp_replace(
--     avatar, '^/api/media/([^/]+)/',
--     'https://YOUR_REF.supabase.co/storage/v1/object/public/\1/')
--    WHERE avatar LIKE '/api/media/%';
--   -- and the same for avatar_thumb_url, cover_url, post_media.url
--
-- Note that reverting the rows is not enough on its own: the buckets must also
-- be made public again, or the restored URLs return 400. The two changes belong
-- together in both directions.
