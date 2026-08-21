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
  mediaPath
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
 * One message for both verification paths.
 *
 * Covers are sniffed from a ranged read in verifyUpload; avatars are sniffed
 * from the downloaded buffer in buildDerivatives. A caller must not be able to
 * tell which by reading the error.
 */
const NOT_AN_IMAGE = 'That file is not a JPEG, PNG or WebP image';

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
/**
 * Resolve an uploaded object after checking it belongs to the caller.
 *
 * The ownership gate and the stat lookup are the same for profile media and
 * post media, and the 403 message must stay byte-identical across both: it is
 * deliberately the same whether the key is malformed, belongs to somebody else,
 * or is nonsense, because a different message would confirm which. That is a
 * security property, and it was previously maintained by two separate copies
 * with two separate comments explaining it.
 *
 * Size limits stay with the callers -- they differ, and post media additionally
 * rejects empty objects before sniffing their bytes.
 */
async function resolveUploadedObject({ key, userId, kind }) {
  const { bucket, maxBytes } = configFor(kind);

  if (!keyBelongsTo(key, userId, kind)) {
    throw new MediaError(403, 'That upload does not belong to you');
  }

  const stat = await statObject(bucket, key);
  if (!stat) {
    throw new MediaError(404, 'No uploaded file found for that key');
  }

  return { bucket, maxBytes, stat };
}

async function verifyUpload({ key, kind, userId }) {
  const { bucket, maxBytes, stat } = await resolveUploadedObject({ key, userId, kind });

  if (stat.size > maxBytes) {
    throw new MediaError(
      413,
      `That ${kind} is too large. Maximum is ${Math.round(maxBytes / 1024 / 1024)}MB.`
    );
  }

  if (stat.size === 0) {
    throw new MediaError(400, 'That upload is empty');
  }

  // Covers are never downloaded — they have no derivative — so a ranged read is
  // the only chance to see their bytes, and it costs 32 bytes instead of 8MB.
  if (kind === 'cover') {
    const prefix = await readRange(bucket, key, SNIFF_LENGTH);
    const actualType = prefix ? sniffImageType(prefix) : null;
    if (!actualType) {
      // Reached by an SVG, an HTML file renamed to .png, or a truncated upload.
      throw new MediaError(400, NOT_AN_IMAGE);
    }
    return { bucket, size: stat.size, contentType: actualType };
  }

  // Avatars are downloaded in full a moment later to build the thumbnail, so a
  // ranged read here would be two extra round-trips for bytes we are about to
  // fetch anyway — measured at ~770ms p50, roughly a third of the whole attach.
  // buildDerivatives sniffs the downloaded buffer instead, before sharp sees
  // it, and throws the identical 400. It is not optional there: an avatar
  // attach that skipped it would persist an unverified object.
  return { bucket, size: stat.size, contentType: null };
}

/**
 * Verify the avatar bytes, build the derivative, return the columns to persist.
 *
 * For avatars this is also the second half of verification — see the block
 * comment below. Do not reorder the download, the sniff and the sharp call
 * without reading it; the sequence is the security property, not a style.
 *
 * The browser already crops and downscales before upload, so the object we read
 * here is small and sharp's work is measured in milliseconds (16ms p50, 25ms
 * p95, measured). That is what makes doing this inline acceptable: there is no
 * queue in this project, and on Vercel any work started after the response is
 * sent is killed when the function returns, so a fire-and-forget "job" would
 * simply never run.
 *
 * A derivative failure is not fatal. The original is already uploaded and
 * verified, so we save that and leave the thumbnail empty; Avatar falls back to
 * the full-size image on its own.
 */
async function buildDerivatives({ bucket, key, kind }) {
  const url = mediaPath(bucket, key);

  if (kind === 'cover') {
    // Covers render at one size. The uploaded object is already cropped wide by
    // the client, so no second object is worth storing.
    return { cover_url: url, cover_key: key };
  }

  const updates = { avatar: url, avatar_key: key, avatar_thumb_url: '' };

  // One download, used for both verification and the thumbnail.
  const source = await getObject(bucket, key);
  if (!source) throw new MediaError(404, 'No uploaded file found for that key');

  // Runs on the downloaded buffer before sharp decodes it.
  //
  // Must stay outside the try/catch below. That handler swallows
  // exceptions to tolerate thumbnail failures; if the sniff moves
  // inside it, a non-image would be accepted and persisted with an
  // empty thumb URL.
  if (!sniffImageType(source)) {
    throw new MediaError(400, NOT_AN_IMAGE);
  }

  try {
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
  resolveUploadedObject,
  verifyUpload,
  buildDerivatives,
  cleanupPrevious,
  AVATAR_MAX_DIMENSION,
  COVER_WIDTH,
  COVER_HEIGHT
};
