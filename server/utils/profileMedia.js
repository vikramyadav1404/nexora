/**
 * Verify-and-attach for profile media.
 *
 * Sits between the upload routes and storage. A client that has PUT an object
 * to a signed URL sends us only its key; everything we then believe about that
 * object is re-derived here rather than taken from the request.
 */
const {
  configFor,
  keyBelongsTo,
  statObject,
  readRange,
  getObject,
  putObject,
  deleteObject,
  getPublicUrl
} = require('./mediaStorage');
const { SNIFF_LENGTH, sniffImageType } = require('./magicBytes');
const {
  renderDerivative,
  AVATAR_MAX_DIMENSION,
  AVATAR_THUMB_DIMENSION,
  COVER_WIDTH,
  COVER_HEIGHT
} = require('./image');

/** Thrown for anything the caller did wrong, so routes can map it to a status. */
class MediaError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Confirm a freshly uploaded object is what it claims to be.
 *
 * Order matters and each step is cheap before the expensive one:
 *   1. key prefix     — no network call, and it is the IDOR gate
 *   2. stat           — one HEAD-equivalent, gives real size and type
 *   3. magic bytes    — a 32-byte ranged read, not a full download
 *
 * Called exactly once per attach. Nothing here lists the bucket.
 */
async function verifyUpload({ key, kind, userId }) {
  const { bucket, maxBytes } = configFor(kind);

  if (!keyBelongsTo(key, userId, kind)) {
    // Deliberately the same message whether the key is malformed or belongs to
    // somebody else — the difference would confirm another user's key exists.
    throw new MediaError(403, 'That upload does not belong to you');
  }

  const stat = await statObject(bucket, key);
  if (!stat) {
    throw new MediaError(404, 'No uploaded file found for that key');
  }

  if (stat.size > maxBytes) {
    throw new MediaError(
      413,
      `That ${kind} is too large. Maximum is ${Math.round(maxBytes / 1024 / 1024)}MB.`
    );
  }

  if (stat.size === 0) {
    throw new MediaError(400, 'That upload is empty');
  }

  const prefix = await readRange(bucket, key, SNIFF_LENGTH);
  const actualType = prefix ? sniffImageType(prefix) : null;
  if (!actualType) {
    // Reached by an SVG, an HTML file renamed to .png, or a truncated upload.
    throw new MediaError(400, 'That file is not a JPEG, PNG or WebP image');
  }

  return { bucket, size: stat.size, contentType: actualType };
}

/**
 * Build the derivative sizes and return the columns to persist.
 *
 * The browser already crops and downscales before upload, so the object we read
 * here is small and sharp's work is measured in milliseconds. That is what
 * makes doing this inline acceptable: there is no queue in this project, and on
 * Vercel any work started after the response is sent is killed when the
 * function returns, so a fire-and-forget "job" would simply never run.
 *
 * A derivative failure is not fatal. The original is already uploaded and
 * valid, so we save that and leave the thumbnail empty; Avatar falls back to
 * the full-size image on its own.
 */
async function buildDerivatives({ bucket, key, kind }) {
  const url = getPublicUrl(bucket, key);

  if (kind === 'cover') {
    // Covers render at one size. The uploaded object is already cropped wide by
    // the client, so no second object is worth storing.
    return { cover_url: url, cover_key: key };
  }

  const updates = { avatar: url, avatar_key: key, avatar_thumb_url: '' };

  try {
    const source = await getObject(bucket, key);
    if (!source) return updates;

    const thumb = await renderDerivative(source, {
      width: AVATAR_THUMB_DIMENSION,
      height: AVATAR_THUMB_DIMENSION
    });

    // Derived from the parent key rather than stored in its own column —
    // cleanupPrevious() recomputes it the same way when deleting.
    const thumbKey = key.replace(/\.([a-z0-9]+)$/i, '') + `-${AVATAR_THUMB_DIMENSION}.webp`;
    const stored = await putObject(bucket, thumbKey, thumb, 'image/webp');
    updates.avatar_thumb_url = stored.url;
  } catch (err) {
    console.warn('[media] thumbnail generation failed, serving full size:', err.message);
  }

  return updates;
}

/**
 * Delete the objects a previous avatar/cover occupied.
 *
 * Best-effort by design — see deleteObject. Runs after the user row is already
 * updated, so a failure here costs storage, never correctness.
 */
async function cleanupPrevious({ kind, previousKey }) {
  if (!previousKey) return;
  const { bucket } = configFor(kind);

  await deleteObject(bucket, previousKey);

  if (kind === 'avatar') {
    const thumbKey = previousKey.replace(/\.([a-z0-9]+)$/i, '') + `-${AVATAR_THUMB_DIMENSION}.webp`;
    await deleteObject(bucket, thumbKey);
  }
}

module.exports = {
  MediaError,
  verifyUpload,
  buildDerivatives,
  cleanupPrevious,
  AVATAR_MAX_DIMENSION,
  COVER_WIDTH,
  COVER_HEIGHT
};
