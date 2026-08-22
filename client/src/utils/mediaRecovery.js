import axios from 'axios';

/**
 * Recovering from a 401 on proxied media.
 *
 * Since media moved behind /api/media, an image is authorised by the
 * `nexora_media` cookie and nothing else -- an <img> cannot send an
 * Authorization header, which is the whole reason the cookie exists.
 *
 * That creates a failure mode the rest of the app does not have: an <img> also
 * cannot retry, cannot refresh a credential, and cannot report why it failed.
 * A single 401 renders as a permanently broken image, and the app never learns
 * anything happened. It is the same shape as an empty state hiding a failed
 * request -- a failure that renders as an absence -- and it deserves the same
 * treatment: make the layer that knows about the failure handle it, once,
 * rather than leaving every call site to render a shrug.
 *
 * The cookie is minted by /api/auth/me, which runs at boot. So the recovery is
 * simply: ask for it again, then retry the image once.
 *
 * ------------------------------------------------------------------
 * Why this is a module and not component state
 * ------------------------------------------------------------------
 * A feed can hold thirty avatars. If the cookie is missing they all fail
 * within a few milliseconds of each other, and thirty components each deciding
 * to "just refresh the cookie" is thirty identical /me calls. The single-flight
 * promise below collapses that burst into one request that all of them await.
 *
 * The cooldown covers the other direction. When /me itself fails -- logged out,
 * server down -- retrying per image turns a broken avatar into a request storm
 * against an endpoint that is already unhappy. After a failure, recovery is
 * refused outright for COOLDOWN_MS and images fall back immediately.
 *
 * The cooldown is a timestamp rather than a permanent "give up" flag on
 * purpose: logging in mints the cookie, so recovery must be able to start
 * working again without a reload. A permanent flag would leave a
 * freshly-logged-in user staring at placeholders.
 */

const COOLDOWN_MS = 30_000;

let inFlight = null;
let lastFailureAt = 0;

/*
 * Indirection so tests can drive this without a network or a DOM. Production
 * uses the app's configured axios -- the same instance carrying withCredentials
 * and the auth interceptors, so recovery behaves exactly like any other call.
 */
let fetchMe = () => axios.get('/api/auth/me');

/**
 * Only our own proxied media is recoverable this way.
 *
 * Accepts the relative form, and an absolute URL whose origin is this page's --
 * both are same-origin requests that carry the cookie.
 *
 * The absolute case is not hypothetical. The server briefly rewrote these paths
 * to an absolute cross-origin host, and because this function only matched the
 * relative form, the recovery path never ran for the one failure it was written
 * for. A guard that silently does not apply is worse than one that is absent:
 * it looks like coverage.
 *
 * Still not a substring match. `https://evil.test/api/media/x` is a different
 * origin and must never trigger an authenticated call.
 */
export function isProxiedMedia(url) {
  if (typeof url !== 'string' || !url) return false;
  if (url.startsWith('/api/media/')) return true;

  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      const here = typeof location !== 'undefined' ? location.origin : null;
      return !!here && parsed.origin === here && parsed.pathname.startsWith('/api/media/');
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Re-mint the media cookie, at most one request at a time.
 *
 * Resolves when the cookie should be present; rejects when it will not be.
 * Callers must treat a rejection as "stop trying", not as an error to surface:
 * a missing avatar is not worth a toast.
 */
export function remintMediaCookie() {
  if (inFlight) return inFlight;

  if (Date.now() - lastFailureAt < COOLDOWN_MS) {
    return Promise.reject(new Error('media cookie recovery is on cooldown'));
  }

  /*
   * The async IIFE starts the request synchronously -- an async function body
   * runs up to its first await before yielding -- while still turning a
   * synchronous throw from fetchMe into a rejection. `Promise.resolve().then()`
   * would also catch the throw but would defer the call by a microtask, which
   * is latency for nothing and makes the single-flight guarantee harder to
   * reason about: `inFlight` would be set before the call it represents.
   */
  inFlight = (async () => fetchMe())()
    .then((value) => {
      inFlight = null;
      return value;
    })
    .catch((err) => {
      inFlight = null;
      lastFailureAt = Date.now();
      throw err;
    });

  return inFlight;
}

/**
 * The URL to retry with.
 *
 * The failed response is `max-age=0, must-revalidate`, so a plain refetch would
 * revalidate correctly on its own. The parameter is here for the element rather
 * than the cache: assigning an identical src is a no-op in every browser, so
 * without a changed URL React would re-render and nothing would be requested.
 */
export function retrySrc(url, attempt) {
  if (!attempt) return url;
  return `${url}${url.includes('?') ? '&' : '?'}nx-retry=${attempt}`;
}

/** Test seam. Not used by the app. */
export function __setFetchMe(fn) {
  fetchMe = fn;
}

/** Test seam. Not used by the app. */
export function __resetMediaRecovery() {
  inFlight = null;
  lastFailureAt = 0;
  fetchMe = () => axios.get('/api/auth/me');
}

export const __COOLDOWN_MS = COOLDOWN_MS;
