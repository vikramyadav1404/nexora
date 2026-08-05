/**
 * Profile-media storage.
 *
 * Every Supabase Storage call for avatars and covers goes through here, so a
 * route handler never imports the storage SDK. If we ever move these objects to
 * R2 or a CDN, this file is the only one that changes.
 *
 * The upload path deliberately does NOT stream bytes through Express. The
 * browser gets a short-lived signed URL and PUTs straight to storage; the API
 * only ever handles the resulting object key. Vercel caps a serverless request
 * body at ~4.5MB, so a cover image large enough to matter would fail before any
 * of our validation ran.
 */
const crypto = require('crypto');
const { getSupabase } = require('../db/supabase');

const KIND_CONFIG = {
  avatar: {
    bucket: 'avatars',
    maxBytes: 5 * 1024 * 1024,
    // Square. 512 is the largest we ever render (profile header at 2x).
    dimension: 512,
    thumbDimension: 128
  },
  cover: {
    bucket: 'covers',
    maxBytes: 8 * 1024 * 1024,
    width: 1500,
    height: 500
  }
};

const ALLOWED_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};
// SVG is absent on purpose: it can carry <script>, and we serve these from a
// public bucket origin.

const SIGNED_URL_TTL_SECONDS = 5 * 60;

function configFor(kind) {
  const config = KIND_CONFIG[kind];
  if (!config) throw new Error(`Unknown media kind: ${kind}`);
  return config;
}

function isAllowedMime(mimeType) {
  return Object.prototype.hasOwnProperty.call(ALLOWED_MIME, mimeType);
}

/**
 * Object keys are always generated here, never taken from the client.
 * A client-supplied filename is both a path-traversal risk and a way to
 * overwrite somebody else's object.
 *
 * The `users/{userId}/` prefix is load-bearing: attach checks it against the
 * authenticated user, which is what stops one account claiming another's upload.
 */
function buildKey({ userId, kind, mimeType }) {
  const ext = ALLOWED_MIME[mimeType];
  if (!ext) throw new Error(`Unsupported mime type: ${mimeType}`);
  return `users/${userId}/${kind}/${crypto.randomUUID()}.${ext}`;
}

/** True when `key` belongs to `userId`. The IDOR gate. */
function keyBelongsTo(key, userId, kind) {
  if (typeof key !== 'string' || !key) return false;
  if (key.includes('..') || key.startsWith('/')) return false;
  return key.startsWith(`users/${userId}/${kind}/`);
}

/**
 * Mint a one-shot upload ticket.
 *
 * Supabase signs a URL for exactly this key, so the ticket cannot be reused to
 * write anywhere else. What it cannot do — unlike an S3 presigned POST — is
 * carry Content-Length or Content-Type conditions. Enforcement therefore sits
 * in two other places: bucket-level size/MIME limits configured in the
 * dashboard, and the verification `attachObject` runs before anything is saved.
 */
async function createUploadTicket({ userId, kind, mimeType }) {
  const { bucket } = configFor(kind);
  const key = buildKey({ userId, kind, mimeType });

  const { data, error } = await getSupabase()
    .storage.from(bucket)
    .createSignedUploadUrl(key);

  if (error) throw error;

  return {
    key,
    bucket,
    signedUrl: data.signedUrl,
    token: data.token,
    expiresIn: SIGNED_URL_TTL_SECONDS
  };
}

/** Size and content type of a stored object, or null when it does not exist. */
async function statObject(bucket, key) {
  const { data, error } = await getSupabase().storage.from(bucket).info(key);
  if (error || !data) return null;
  return {
    size: Number(data.size ?? data.contentLength ?? 0),
    contentType: data.contentType || data.mimetype || '',
    lastModified: data.lastModified || data.updated_at || null
  };
}

/**
 * Read the first `length` bytes of an object.
 *
 * Used to check magic bytes without pulling a whole 8MB cover down. A signed
 * download URL plus a Range header is one small request; `download()` would
 * fetch the entire object.
 */
async function readRange(bucket, key, length = 32) {
  const { data, error } = await getSupabase()
    .storage.from(bucket)
    .createSignedUrl(key, 60);
  if (error || !data?.signedUrl) return null;

  const res = await fetch(data.signedUrl, {
    headers: { Range: `bytes=0-${length - 1}` }
  });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

/** Full object bytes. Only called when we are about to run sharp over them. */
async function getObject(bucket, key) {
  const { data, error } = await getSupabase().storage.from(bucket).download(key);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

async function putObject(bucket, key, buffer, contentType) {
  const { error } = await getSupabase()
    .storage.from(bucket)
    .upload(key, buffer, { contentType, upsert: true });
  if (error) throw error;
  return { key, url: getPublicUrl(bucket, key) };
}

/**
 * Best-effort delete. A failure here leaks one object; throwing would fail a
 * request the user experiences as successful, which is the worse trade. The
 * daily cron sweep is the backstop.
 */
async function deleteObject(bucket, key) {
  if (!key) return false;
  try {
    const { error } = await getSupabase().storage.from(bucket).remove([key]);
    if (error) {
      console.warn('media cleanup failed for', key, '-', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('media cleanup threw for', key, '-', err.message);
    return false;
  }
}

function getPublicUrl(bucket, key) {
  const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  return `${base}/storage/v1/object/public/${bucket}/${key}`;
}

module.exports = {
  KIND_CONFIG,
  ALLOWED_MIME,
  SIGNED_URL_TTL_SECONDS,
  configFor,
  isAllowedMime,
  buildKey,
  keyBelongsTo,
  createUploadTicket,
  statObject,
  readRange,
  getObject,
  putObject,
  deleteObject,
  getPublicUrl
};
