/**
 * Identify an image from its leading bytes.
 *
 * The Content-Type on an upload is whatever the client claimed. A file named
 * avatar.png, declared as image/png, can hold anything at all — and because we
 * serve these back from a public bucket origin, "anything at all" includes an
 * HTML document with a script tag in it.
 *
 * So the declared type is treated as a hint and the first bytes decide.
 */

/** Bytes we need to see to identify every format below. */
const SNIFF_LENGTH = 32;

function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e &&
    buffer[3] === 0x47 && buffer[4] === 0x0d && buffer[5] === 0x0a &&
    buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  // WebP: "RIFF" .... "WEBP" — the size field sits between the two markers.
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

/**
 * Identify a video container from its leading bytes.
 *
 * Feed attachments now go browser-to-storage, so this is the only point where
 * the server ever sees a video's bytes. Without it, "video/mp4" would be a
 * claim nobody checks, and the object is served back from a public origin.
 *
 * Container detection only — nothing here validates the streams inside, which
 * would need a demuxer. It is enough to reject a file that is not a video at
 * all, which is the case that matters.
 */
function sniffVideoType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  // MP4 / MOV: a box whose type is "ftyp" at offset 4. The brand that follows
  // distinguishes them, and both are served identically, so it is not read.
  if (buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12);
    return brand.startsWith('qt') ? 'video/quicktime' : 'video/mp4';
  }

  // WebM / Matroska: EBML header 1A 45 DF A3
  if (
    buffer[0] === 0x1a && buffer[1] === 0x45 &&
    buffer[2] === 0xdf && buffer[3] === 0xa3
  ) {
    return 'video/webm';
  }

  return null;
}

/**
 * Does the object's real content match what was declared?
 *
 * JPEG is the one place we accept a mismatch in naming only: image/jpg is not a
 * registered type but browsers and phone cameras emit it constantly, and the
 * bytes are identical.
 */
function matchesDeclared(buffer, declaredMime) {
  const actual = sniffImageType(buffer);
  if (!actual) return { ok: false, actual: null };

  const normalized = declaredMime === 'image/jpg' ? 'image/jpeg' : declaredMime;
  return { ok: actual === normalized, actual };
}

module.exports = { SNIFF_LENGTH, sniffImageType, sniffVideoType, matchesDeclared };
