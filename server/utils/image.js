/**
 * Image processing for uploads.
 *
 * Before this, uploads were stored byte-for-byte as received: a modern phone
 * photo is 4–12MB and 4000px wide, and every viewer downloaded all of it to
 * display a 640px-wide post. On mobile data that is slow and expensive, and it
 * burns Supabase Storage bandwidth for no benefit.
 *
 * Now images are resized and re-encoded to WebP before storage. Typical saving
 * is 90–97%. Videos pass through untouched — transcoding needs ffmpeg, which is
 * a much bigger dependency and out of scope here.
 */
/*
 * sharp is a native module — it ships a different prebuilt binary per platform.
 * The lockfile carries @img/sharp-linux-x64 so Vercel resolves it correctly,
 * but a native load failure at import time would crash the entire API before
 * a single route was registered.
 *
 * Loading it defensively means the worst case is "images are stored at full
 * size", not "the site is down".
 */
let sharp = null;
try {
  sharp = require('sharp');
} catch (err) {
  console.warn(
    `[image] sharp unavailable (${err.message}) — uploads will be stored ` +
    'unoptimized. Check that @img/sharp-linux-x64 installed on this platform.'
  );
}

/** Feed images never render wider than ~640 CSS px; 1600 covers 2x displays. */
const POST_MAX_DIMENSION = 1600;
const AVATAR_MAX_DIMENSION = 512;

const WEBP_QUALITY = 82;

function isImage(file) {
  return /^image\//.test(file?.mimetype || '');
}

/** Animated GIFs lose their animation through the still encoder — leave them. */
function isAnimated(file) {
  return /gif/i.test(file?.mimetype || '');
}

/**
 * Resize + re-encode an upload.
 *
 * Returns a new file-like object with `.buffer`, `.mimetype` and `.originalname`
 * updated, so callers can hand it straight to uploadMedia().
 *
 * Never throws: if sharp cannot read the buffer (corrupt file, exotic format)
 * the original is returned unchanged. A slightly large image is a far better
 * outcome than a failed post.
 */
async function optimizeImage(file, { kind = 'post' } = {}) {
  if (!sharp) {
    return { file, optimized: false, reason: 'sharp unavailable on this platform' };
  }
  if (!file?.buffer || !isImage(file) || isAnimated(file)) {
    return { file, optimized: false, reason: 'not a still image' };
  }

  const maxDim = kind === 'avatar' ? AVATAR_MAX_DIMENSION : POST_MAX_DIMENSION;
  const before = file.buffer.length;

  try {
    const pipeline = sharp(file.buffer, { failOn: 'none' })
      // Honour EXIF orientation, then drop the metadata — phone photos carry
      // GPS coordinates, which we should not be republishing.
      .rotate()
      .resize({
        width: maxDim,
        height: maxDim,
        fit: 'inside',
        withoutEnlargement: true // never upscale a small image
      })
      .webp({ quality: WEBP_QUALITY });

    const buffer = await pipeline.toBuffer();

    // Re-encoding can occasionally produce a larger file (already-optimised
    // WebP, tiny PNGs). Keep whichever is smaller.
    if (buffer.length >= before) {
      return { file, optimized: false, reason: 'original was already smaller' };
    }

    const name = String(file.originalname || 'upload').replace(/\.[^.]+$/, '') + '.webp';

    return {
      file: { ...file, buffer, mimetype: 'image/webp', originalname: name, size: buffer.length },
      optimized: true,
      before,
      after: buffer.length,
      saved: Math.round((1 - buffer.length / before) * 100)
    };
  } catch (err) {
    // Corrupt or unsupported — store what we were given.
    console.warn('[image] optimize failed, storing original:', err.message);
    return { file, optimized: false, reason: err.message };
  }
}

/** Small avatar, used in comment threads and post cards. */
const AVATAR_THUMB_DIMENSION = 128;
const COVER_WIDTH = 1500;
const COVER_HEIGHT = 500;

/**
 * Re-encode a buffer to WebP at exact dimensions.
 *
 * Unlike optimizeImage() this **throws** when sharp cannot read the input.
 * That difference is the point. A feed post that fails to optimise should still
 * publish, but profile media that sharp cannot decode is not an image we should
 * be storing at all — silently keeping the original is how a text/html payload
 * ends up served from our bucket origin.
 *
 * `cover: true` crops to fill the frame instead of fitting inside it; a banner
 * with letterboxing looks broken.
 */
async function renderDerivative(buffer, { width, height, cover = true } = {}) {
  if (!sharp) throw new Error('sharp is unavailable on this platform');
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Empty image buffer');

  return sharp(buffer, { failOn: 'error' })
    .rotate()
    .resize({
      width,
      height,
      fit: cover ? 'cover' : 'inside',
      position: 'attention', // crop toward the busiest region, usually the face
      withoutEnlargement: false
    })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
}

module.exports = {
  optimizeImage,
  renderDerivative,
  POST_MAX_DIMENSION,
  AVATAR_MAX_DIMENSION,
  AVATAR_THUMB_DIMENSION,
  COVER_WIDTH,
  COVER_HEIGHT
};
