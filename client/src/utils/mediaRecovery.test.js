/**
 * The media-401 recovery path.
 *
 * The client had no tests before this one. It gets them here because the
 * interesting part of this fix is not the React glue -- it is the burst and
 * failure handling, which is exactly the kind of logic that looks obviously
 * correct and is not: a feed of thirty avatars failing at once is the normal
 * case, not the edge case.
 *
 * Each of these was checked by mutation -- delete the guard, confirm the test
 * goes red -- because a test that passes with the behaviour removed is worse
 * than no test at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isProxiedMedia,
  remintMediaCookie,
  retrySrc,
  __setFetchMe,
  __resetMediaRecovery,
  __COOLDOWN_MS
} from './mediaRecovery.js';

beforeEach(() => {
  __resetMediaRecovery();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-22T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  __resetMediaRecovery();
});

describe('what counts as recoverable', () => {
  it('recognises our own proxied media', () => {
    expect(isProxiedMedia('/api/media/avatars/users/a/avatar/b.webp')).toBe(true);
  });

  it('REGRESSION: does not try to re-auth for anything else', () => {
    // Re-minting a cookie cannot fix a dead third-party URL, and firing /me at
    // every broken external image would be a self-inflicted request storm.
    expect(isProxiedMedia('https://example.com/x.png')).toBe(false);
    expect(isProxiedMedia('/uploads/x.png')).toBe(false);
    expect(isProxiedMedia('data:image/png;base64,AAAA')).toBe(false);
    expect(isProxiedMedia('')).toBe(false);
    expect(isProxiedMedia(undefined)).toBe(false);
    expect(isProxiedMedia(null)).toBe(false);
  });

  it('REGRESSION: is not fooled by a lookalike host', () => {
    // Substring matching would let an attacker-controlled host trigger the auth
    // call. Only same-origin qualifies.
    expect(isProxiedMedia('https://evil.test/api/media/avatars/x')).toBe(false);
    expect(isProxiedMedia('https://client-olive-ten-89.vercel.app.evil.test/api/media/x')).toBe(false);
  });

  it('REGRESSION: recognises a same-origin ABSOLUTE url', () => {
    /*
     * The case that made this guard useless exactly when it was needed.
     *
     * The server briefly rewrote media paths to an absolute host. Because this
     * only matched the relative form, every avatar 401'd and the recovery path
     * never ran -- the fallback was present, tested, and silently inapplicable
     * to the one failure it existed for.
     *
     * jsdom is not configured here, so location is stubbed for this case.
     */
    const original = globalThis.location;
    globalThis.location = { origin: 'https://client-olive-ten-89.vercel.app' };
    try {
      expect(isProxiedMedia('https://client-olive-ten-89.vercel.app/api/media/avatars/x.webp')).toBe(true);
      // Same origin, but not a media path.
      expect(isProxiedMedia('https://client-olive-ten-89.vercel.app/api/auth/me')).toBe(false);
      // A media path, but the API's own host -- a different origin from the page.
      expect(isProxiedMedia('https://nexora-api-beta.vercel.app/api/media/avatars/x.webp')).toBe(false);
    } finally {
      if (original === undefined) delete globalThis.location;
      else globalThis.location = original;
    }
  });

  it('does not throw on a malformed url', () => {
    expect(isProxiedMedia('http://[not a url')).toBe(false);
  });
});

describe('a burst of failures', () => {
  it('REGRESSION: thirty images produce one /me call, not thirty', async () => {
    // The whole reason this lives in a module instead of component state.
    let calls = 0;
    let release;
    __setFetchMe(() => {
      calls += 1;
      return new Promise((resolve) => { release = resolve; });
    });

    const pending = Array.from({ length: 30 }, () => remintMediaCookie());
    expect(calls).toBe(1);

    release({ ok: true });
    await Promise.all(pending);
    expect(calls).toBe(1);
  });

  it('every waiter in the burst is resolved, not just the first', async () => {
    // If the followers did not share the promise they would hang, and their
    // images would sit broken forever with no error to show.
    __setFetchMe(() => Promise.resolve({ ok: true }));

    const results = await Promise.allSettled([
      remintMediaCookie(), remintMediaCookie(), remintMediaCookie()
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('allows a fresh attempt once the previous one has settled', async () => {
    // A cookie can expire again later. Success must not latch the gate shut.
    let calls = 0;
    __setFetchMe(() => { calls += 1; return Promise.resolve({ ok: true }); });

    await remintMediaCookie();
    await remintMediaCookie();
    expect(calls).toBe(2);
  });
});

describe('when /me itself fails', () => {
  it('REGRESSION: refuses further attempts during the cooldown', async () => {
    // Logged out or server down: retrying per image turns a broken avatar into
    // a request storm against an endpoint that is already failing.
    let calls = 0;
    __setFetchMe(() => { calls += 1; return Promise.reject(new Error('401')); });

    await expect(remintMediaCookie()).rejects.toThrow();
    expect(calls).toBe(1);

    await expect(remintMediaCookie()).rejects.toThrow(/cooldown/);
    await expect(remintMediaCookie()).rejects.toThrow(/cooldown/);
    expect(calls).toBe(1);
  });

  it('REGRESSION: recovers after the cooldown, because logging in fixes it', async () => {
    /*
     * The reason the cooldown is a timestamp and not a permanent give-up flag.
     * Signing in mints the cookie, so a user who logs in must not be left
     * staring at placeholders until they reload.
     */
    let calls = 0;
    __setFetchMe(() => { calls += 1; return Promise.reject(new Error('401')); });

    await expect(remintMediaCookie()).rejects.toThrow();
    vi.setSystemTime(Date.now() + __COOLDOWN_MS + 1);

    await expect(remintMediaCookie()).rejects.toThrow();
    expect(calls).toBe(2);
  });

  it('does not leave the single-flight promise stuck after a failure', async () => {
    // A rejected in-flight promise that was never cleared would block every
    // future attempt for the life of the page.
    let calls = 0;
    __setFetchMe(() => { calls += 1; return Promise.reject(new Error('nope')); });

    await expect(remintMediaCookie()).rejects.toThrow();
    vi.setSystemTime(Date.now() + __COOLDOWN_MS + 1);
    await expect(remintMediaCookie()).rejects.toThrow();

    expect(calls).toBe(2);
  });

  it('a throw from the fetcher rejects rather than escaping synchronously', async () => {
    // onError is not an async context; a synchronous throw here would surface
    // as an unhandled error in an event handler.
    __setFetchMe(() => { throw new Error('sync boom'); });
    await expect(remintMediaCookie()).rejects.toThrow('sync boom');
  });
});

describe('the retry URL', () => {
  it('is unchanged on the first attempt', () => {
    expect(retrySrc('/api/media/a/b.webp', 0)).toBe('/api/media/a/b.webp');
  });

  it('REGRESSION: differs from the original, or the browser would not refetch', () => {
    // Assigning an identical src is a no-op in every browser, so without this
    // the retry would re-render and request nothing.
    const url = '/api/media/a/b.webp';
    expect(retrySrc(url, 1)).not.toBe(url);
    expect(retrySrc(url, 1)).toBe('/api/media/a/b.webp?nx-retry=1');
  });

  it('appends correctly to a URL that already has a query', () => {
    expect(retrySrc('/api/media/a/b.webp?v=2', 1)).toBe('/api/media/a/b.webp?v=2&nx-retry=1');
  });
});
