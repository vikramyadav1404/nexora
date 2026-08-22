import { useCallback, useState } from 'react';
import { isProxiedMedia, remintMediaCookie, retrySrc } from '../utils/mediaRecovery';

/**
 * Shared <img> error handling for Avatar and SmartImage.
 *
 * Both components previously treated onError as terminal: one failure, fall
 * back to an initial or a placeholder glyph, never look again. For a dead
 * external URL that is right. For our own /api/media that is wrong -- the most
 * likely cause is a missing cookie, which is recoverable, and giving up makes a
 * transient credential problem look like a deleted file.
 *
 * So: proxied media gets exactly one retry, after re-minting the cookie.
 * Anything else fails as before. The retry is capped at one because the second
 * failure is evidence the image really is gone, and an <img> that keeps
 * retrying is a loop nobody can see.
 */
export function useMediaFallback(src) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [owner, setOwner] = useState(src);

  /*
   * When the src changes the old outcome is meaningless -- a recycled row in a
   * virtualised list must not inherit the previous user's broken avatar.
   * Adjusting state during render is React's documented answer to this and
   * avoids the extra committed render an effect would cost.
   */
  const stale = owner !== src;
  if (stale) {
    setOwner(src);
    setAttempt(0);
    setFailed(false);
  }

  const onError = useCallback(() => {
    if (attempt === 0 && isProxiedMedia(src)) {
      remintMediaCookie().then(
        () => setAttempt(1),
        // Rejection means recovery is unavailable or on cooldown. That is a
        // decision, not an error to report: show the fallback quietly.
        () => setFailed(true)
      );
      return;
    }
    setFailed(true);
  }, [attempt, src]);

  return {
    src: stale ? src : retrySrc(src, attempt),
    failed: stale ? false : failed,
    onError
  };
}

export default useMediaFallback;
