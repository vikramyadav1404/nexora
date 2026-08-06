-- ============================================================
-- NEXORA 011 — record the storage key on post media
-- Run after 010_mfa.sql. Safe to re-run.
-- ============================================================
--
-- Post attachments used to be uploaded as multipart through the API: the bytes
-- went to the Express handler, which pushed them to storage and saved only the
-- resulting public URL. That worked, but it capped uploads at whatever the
-- serverless platform allows in a request body -- roughly 4.5MB on Vercel --
-- while the composer advertised 50MB. An ordinary phone photo failed with
-- nothing useful to show for it.
--
-- Attachments now take the same route avatars and covers already do: the
-- browser is handed a signed URL and PUTs straight to storage, then the API
-- verifies the object by key. That means the key is worth keeping.
--
-- Two things need it:
--   * deleting a post can now delete its objects instead of orphaning them
--   * the daily sweep in routes/cron.js can cover the posts bucket the way it
--     already covers profile media, by comparing bucket contents against keys
--     recorded here
--
-- A URL cannot serve either purpose: it is the public read address, not the
-- object path, and it does not survive a bucket or CDN change.

ALTER TABLE post_media ADD COLUMN IF NOT EXISTS storage_key TEXT DEFAULT '';

COMMENT ON COLUMN post_media.storage_key IS
  'Object path in the posts bucket. Empty for rows written by the older multipart upload path, which only kept the public URL.';

-- Partial: rows from the multipart path carry '' and are not worth indexing.
-- The sweep and the delete path both look up by a real key or not at all.
CREATE INDEX IF NOT EXISTS idx_post_media_storage_key
  ON post_media (storage_key)
  WHERE storage_key <> '';

-- ============================================================
-- Deliberately NOT done
-- ============================================================
-- No NOT NULL, and no backfill. Existing rows genuinely have no key -- the old
-- path never recorded one and it cannot be recovered from the URL. Making the
-- column required would either fail on those rows or force an invented value,
-- and code that reads it must handle the empty case regardless.
