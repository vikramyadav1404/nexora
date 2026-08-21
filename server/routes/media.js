const express = require('express');
const router = express.Router();
const { getSupabase } = require('../db/supabase');
const { verifyMediaToken, MEDIA_COOKIE } = require('../utils/tokens');
const { KIND_CONFIG } = require('../utils/mediaStorage');
const { asyncHandler } = require('../utils/respond');

/**
 * Serve stored media behind an authorisation check.
 *
 * All three buckets used to be public, so every avatar, cover and post
 * attachment was readable by anyone with the URL -- forever, regardless of the
 * post's is_public flag, and it survived the account being deleted. A public
 * bucket cannot express "only people who can see this post", so the check has
 * to happen somewhere that can, which is here.
 *
 * This does not stream bytes. It authorises, then redirects to a short-lived
 * signed URL, so Supabase's CDN still serves the object and this function stays
 * a cheap auth check rather than a proxy paying for every byte twice.
 *
 * Authentication is the media cookie, not the Authorization header: the browser
 * issues <img> and <video> requests itself and cannot attach one. See
 * utils/tokens.js for why SameSite=Lax is the right scope.
 */

/** How long a redirect target stays valid. Long enough to fetch, not to share. */
const SIGNED_URL_TTL_SECONDS = 60;

/** bucket name -> the kind whose key prefix it uses. */
const BUCKET_KINDS = Object.fromEntries(
  Object.entries(KIND_CONFIG).map(([kind, cfg]) => [cfg.bucket, kind])
);

/**
 * The owning user id encoded in a key, or null.
 *
 * Keys are `users/<uuid>/<kind>/<uuid>.<ext>` (mediaStorage.buildKey). Anything
 * else -- a traversal, an absolute path, a shape we did not write -- is refused
 * rather than interpreted.
 */
function ownerOf(key, kind) {
  if (typeof key !== 'string' || !key) return null;
  if (key.includes('..') || key.startsWith('/')) return null;

  const parts = key.split('/');
  if (parts.length !== 4) return null;
  if (parts[0] !== 'users' || parts[2] !== kind) return null;
  return parts[1] || null;
}

/**
 * May `viewerId` see this post attachment?
 *
 * Two questions a public bucket could not ask: is the post public, and has its
 * author blocked the viewer. Own media is always visible to its owner.
 */
async function mayViewPostMedia(db, key, viewerId, ownerId) {
  if (viewerId === ownerId) return true;

  const { data: media } = await db
    .from('post_media')
    .select('post_id')
    .eq('storage_key', key)
    .maybeSingle();

  // No row means nothing points at this object. It is either an orphan or an
  // upload still in flight; either way it is not something to hand out.
  if (!media?.post_id) return false;

  const { data: post } = await db
    .from('posts')
    .select('id, author_id, is_public')
    .eq('id', media.post_id)
    .maybeSingle();

  if (!post) return false;
  if (post.is_public === false && post.author_id !== viewerId) return false;

  const { data: block } = await db
    .from('blocks')
    .select('id')
    .eq('blocker_id', post.author_id)
    .eq('blocked_id', viewerId)
    .maybeSingle();

  return !block;
}

/**
 * GET /api/media/:bucket/*
 *
 * The wildcard is the object key, which contains slashes.
 */
router.get('/:bucket/*', asyncHandler(async (req, res) => {
  const { bucket } = req.params;
  const key = req.params[0];

  const kind = BUCKET_KINDS[bucket];
  if (!kind) return res.status(404).json({ message: 'Not found' });

  /*
   * The cookie, and only the cookie.
   *
   * An Authorization header is deliberately not accepted here. It is the one
   * thing an <img> can never send, so accepting it would let the tests and
   * manual curl checks pass while every real image on the site was broken --
   * the code would look authorised and the product would not work.
   */
  const viewerId = verifyMediaToken(req.cookies?.[MEDIA_COOKIE]);
  if (!viewerId) {
    return res.status(401).json({ message: 'Not authorized to view this media' });
  }

  const ownerId = ownerOf(key, kind);
  if (!ownerId) return res.status(403).json({ message: 'Not authorized to view this media' });

  const db = getSupabase();

  /*
   * Avatars and covers are visible to any signed-in user -- they render on
   * every profile, feed row and comment, and hiding them would mean hiding the
   * app. Post media is the case with something to protect.
   */
  if (kind === 'post') {
    const allowed = await mayViewPostMedia(db, key, viewerId, ownerId);
    if (!allowed) {
      return res.status(403).json({ message: 'Not authorized to view this media' });
    }
  }

  const { data, error } = await db.storage
    .from(bucket)
    .createSignedUrl(key, SIGNED_URL_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    return res.status(404).json({ message: 'Media not found' });
  }

  /*
   * 302, not 301: the signed URL expires, so it must never be cached as a
   * permanent location. The redirect itself is marked private and short-lived
   * for the same reason -- a shared cache holding it would hand one user's
   * signed URL to another.
   */
  res.set('Cache-Control', `private, max-age=${SIGNED_URL_TTL_SECONDS}`);
  return res.redirect(302, data.signedUrl);
}, 'Could not load that media'));

module.exports = router;
module.exports.__ownerOf = ownerOf;
module.exports.__mayViewPostMedia = mayViewPostMedia;
