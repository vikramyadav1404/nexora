/**
 * Verification for feed attachments uploaded straight to storage.
 *
 * Post media used to arrive as multipart through the API, so the handler held
 * the bytes and could inspect them before writing anything. It also meant every
 * upload passed through the serverless function, which rejects a request body
 * over roughly 4.5MB — the composer advertised 50MB and an ordinary phone photo
 * failed with nothing useful to show for it.
 *
 * The browser now PUTs to a signed URL and sends us only a key. That moves the
 * inspection here, and it has to be thorough, because a signed Supabase upload
 * URL cannot carry Content-Length or Content-Type conditions the way an S3
 * presigned POST can. Between minting the ticket and this function running, the
 * client controls the bytes completely.
 *
 * What that does and does not buy:
 *
 *   - A post is only ever created from an object that passed every check here,
 *     so there is no way to attach an unverified file to a post.
 *   - The object still lands in the bucket before anyone checks it. Nothing in
 *     this file can prevent that. The bucket's own file-size limit in the
 *     Supabase dashboard and the presign rate limiter are what bound the abuse;
 *     the daily sweep removes anything never attached.
 */
const { MediaError } = require('./profileMedia');
const { SNIFF_LENGTH, sniffImageType, sniffVideoType } = require('./magicBytes');
const {
  configFor,
  keyBelongsTo,
  statObject,
  readRange,
  getPublicUrl,
  POST_ALLOWED_MIME
} = require('./mediaStorage');

const NOT_MEDIA =
  'That file is not a supported image or video. Use JPEG, PNG, WebP, MP4, WebM or MOV.';

/** Post media is one of exactly two things, and the bytes decide which. */
function classify(prefix) {
  const image = sniffImageType(prefix);
  if (image) return { type: 'image', contentType: image };

  const video = sniffVideoType(prefix);
  if (video) return { type: 'video', contentType: video };

  return null;
}

/**
 * Check one uploaded object and describe it.
 *
 * Order matters. Ownership is first so a probe for somebody else's key cannot
 * be distinguished from a probe for a key that does not exist — both answer the
 * same way, and neither reaches storage.
 *
 * @returns {Promise<{ key, bucket, url, type, contentType, size }>}
 */
async function verifyPostUpload({ key, userId }) {
  const { bucket, maxBytes } = configFor('post');

  if (!keyBelongsTo(key, userId, 'post')) {
    // Deliberately identical whether the key is malformed, belongs to another
    // user, or is nonsense — a different message would confirm which.
    throw new MediaError(403, 'That upload does not belong to you');
  }

  const stat = await statObject(bucket, key);
  if (!stat) {
    throw new MediaError(404, 'No uploaded file found for that key');
  }

  if (stat.size === 0) {
    throw new MediaError(400, 'That upload is empty');
  }

  // The size declared at presign was a courtesy so the browser could fail fast.
  // This is the number that counts: it comes from storage, not the client.
  if (stat.size > maxBytes) {
    throw new MediaError(
      413,
      `That file is too large. Maximum is ${Math.round(maxBytes / 1024 / 1024)}MB.`
    );
  }

  /*
   * A ranged read, not a download.
   *
   * Unlike avatars there is no derivative to build, so the full bytes are never
   * needed — and for a 50MB video, pulling them into a serverless function to
   * look at the first 32 would be absurd.
   */
  const prefix = await readRange(bucket, key, SNIFF_LENGTH);
  const actual = prefix ? classify(prefix) : null;

  if (!actual) {
    // Reached by an SVG, an HTML file renamed to .png, or a truncated upload.
    throw new MediaError(400, NOT_MEDIA);
  }

  // The extension came from the mime type the client declared at presign. If
  // the real bytes disagree, the declared type was a lie and the object would
  // be served under the wrong Content-Type from a public origin.
  const declaredExt = String(key).split('.').pop()?.toLowerCase();
  const expectedExt = POST_ALLOWED_MIME[actual.contentType];

  /*
   * Two pairs are interchangeable and must not be treated as a mismatch.
   *
   * jpg/jpeg is naming only. mp4/mov matters more: both are ISO base media
   * files starting with the same `ftyp` box, and the brand that distinguishes
   * them is inconsistent in the wild — plenty of .mov files from phones carry
   * an mp4 brand and vice versa. Rejecting on that difference would bounce
   * perfectly good video, and the two are served identically anyway.
   */
  const interchangeable = new Set(['jpg|jpeg', 'jpeg|jpg', 'mp4|mov', 'mov|mp4']);

  if (expectedExt !== declaredExt && !interchangeable.has(`${expectedExt}|${declaredExt}`)) {
    throw new MediaError(400, NOT_MEDIA);
  }

  return {
    key,
    bucket,
    url: getPublicUrl(bucket, key),
    type: actual.type,
    contentType: actual.contentType,
    size: stat.size
  };
}

module.exports = { verifyPostUpload, NOT_MEDIA };
