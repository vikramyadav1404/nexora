/**
 * Stored media is behind an authorisation check.
 *
 * All three buckets were public, so every avatar, cover and post attachment was
 * readable by anyone holding the URL -- forever, ignoring the post's is_public
 * flag, and still live after the account was deleted. I confirmed it by
 * fetching a real avatar with no credentials and getting 200.
 *
 * That probe is the first test below, in the shape it was performed: assert the
 * thing that must not work. A test that only checks the happy path would pass
 * just as well with the guard deleted.
 *
 * Note what is deliberately NOT accepted: an Authorization header. It is the
 * one credential a browser cannot attach to an <img> request, so accepting it
 * would let every test here pass while every image on the site was broken --
 * authorised-looking code and a non-working product.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createRequire } from 'node:module';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

const require = createRequire(import.meta.url);
const { __setTestClient } = require('../db/supabase.js');
const { signMediaToken, signAccessToken, MEDIA_COOKIE } = require('../utils/tokens.js');
const { mediaPath } = require('../utils/mediaStorage.js');

const SECRET = 'a-test-secret-long-enough-to-pass-the-floor';
const OWNER = '00000000-0000-4000-8000-00000000000a';
const VIEWER = '00000000-0000-4000-8000-00000000000b';

const AVATAR_KEY = `users/${OWNER}/avatar/aaaaaaaa-1111-4000-8000-000000000001.webp`;
const POST_KEY = `users/${OWNER}/post/bbbbbbbb-2222-4000-8000-000000000002.jpg`;

let db;
const saved = {};

function app() {
  const a = express();
  a.use(cookieParser());
  a.use(express.json());
  a.use('/api/media', require('../routes/media.js'));
  return a;
}

/** A request the way a browser issues one for <img src>: cookies, no header. */
const asImg = (path, token) => {
  const r = request(app()).get(path).redirects(0);
  return token ? r.set('Cookie', `${MEDIA_COOKIE}=${token}`) : r;
};

function setup({ posts = [], post_media = [], blocks = [] } = {}) {
  db = createFakeSupabase({
    users: [{ id: OWNER, name: 'Owner' }, { id: VIEWER, name: 'Viewer' }],
    posts, post_media, blocks
  });
  // Objects must exist for createSignedUrl to succeed.
  db._objects.set(`avatars/${AVATAR_KEY}`, { buffer: Buffer.from('x'), contentType: 'image/webp' });
  db._objects.set(`posts/${POST_KEY}`, { buffer: Buffer.from('x'), contentType: 'image/jpeg' });
  __setTestClient(db);
}

beforeEach(() => {
  saved.JWT_SECRET = process.env.JWT_SECRET;
  saved.NODE_ENV = process.env.NODE_ENV;
  process.env.JWT_SECRET = SECRET;
  process.env.NODE_ENV = 'test';
  setup();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('no credentials means no media', () => {
  it('REGRESSION: an avatar cannot be fetched with no credentials at all', async () => {
    // The exact check that found the flaw. It returned 200 against the live
    // bucket; here it must not, and must not redirect either.
    const res = await asImg(`/api/media/avatars/${AVATAR_KEY}`);

    expect(res.status).toBe(401);
    // Asserted on the absence of the redirect, not just the status: a handler
    // that denied and redirected anyway would still hand over the signed URL.
    expect(res.headers.location).toBeUndefined();
  });

  it('REGRESSION: post media cannot be fetched with no credentials', async () => {
    const res = await asImg(`/api/media/posts/${POST_KEY}`);
    expect(res.status).toBe(401);
    expect(res.headers.location).toBeUndefined();
  });

  it('REGRESSION: an Authorization header is not a substitute for the cookie', async () => {
    // A browser cannot send this for an <img>. Accepting it would make the
    // tests pass and the site show broken images.
    const res = await request(app())
      .get(`/api/media/avatars/${AVATAR_KEY}`)
      .set('Authorization', `Bearer ${signAccessToken(VIEWER)}`)
      .redirects(0);

    expect(res.status).toBe(401);
    expect(res.headers.location).toBeUndefined();
  });

  it('REGRESSION: an access token in the media cookie is refused', async () => {
    // Different lifetime, different blast radius. They are not interchangeable.
    const res = await asImg(`/api/media/avatars/${AVATAR_KEY}`, signAccessToken(VIEWER));
    expect(res.status).toBe(401);
  });

  it('a forged or corrupted media cookie is refused', async () => {
    expect((await asImg(`/api/media/avatars/${AVATAR_KEY}`, 'not-a-jwt')).status).toBe(401);

    const jwt = require('jsonwebtoken');
    const forged = jwt.sign({ id: VIEWER, typ: 'media' }, 'the-wrong-secret', { expiresIn: '1h' });
    expect((await asImg(`/api/media/avatars/${AVATAR_KEY}`, forged)).status).toBe(401);
  });
});

describe('with a valid media cookie', () => {
  const token = () => signMediaToken(VIEWER);

  it('redirects to a signed URL rather than serving bytes', async () => {
    const res = await asImg(`/api/media/avatars/${AVATAR_KEY}`, token());

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/object/sign/');
    // Never a permanent redirect: the target expires.
    expect(res.status).not.toBe(301);
  });

  it('marks the redirect private so a shared cache cannot hand it on', async () => {
    const res = await asImg(`/api/media/avatars/${AVATAR_KEY}`, token());
    expect(res.headers['cache-control']).toMatch(/private/);
  });

  it('refuses a traversing key at the route', async () => {
    // Refused, but by the shape check rather than the traversal check -- see
    // the unit test below for why the route cannot reach the latter.
    const traversal = `users/%2e%2e/avatar/x.webp`;
    const res = await asImg(`/api/media/avatars/${traversal}`, token());

    expect(res.status).toBe(403);
    expect(res.headers.location).toBeUndefined();
  });

  it('refuses a key whose shape is not one we write', async () => {
    // Normalised traversal lands here: wrong segment count.
    const res = await asImg(`/api/media/avatars/users/${OWNER}/avatar/../../../etc/passwd`, token());
    expect([403, 404]).toContain(res.status);
    expect(res.headers.location).toBeUndefined();
  });

  it('REGRESSION: refuses a key that does not match the bucket its kind uses', async () => {
    // A post key served out of the avatars bucket would skip the post checks.
    const res = await asImg(`/api/media/avatars/${POST_KEY}`, token());
    expect(res.status).toBe(403);
  });

  it('refuses an unknown bucket', async () => {
    const res = await asImg(`/api/media/secrets/${AVATAR_KEY}`, token());
    expect(res.status).toBe(404);
  });
});

describe('post media answers the questions a public bucket could not', () => {
  const token = () => signMediaToken(VIEWER);

  it('a public post is visible to another signed-in user', async () => {
    setup({
      posts: [{ id: 'p1', author_id: OWNER, is_public: true }],
      post_media: [{ id: 'pm1', post_id: 'p1', storage_key: POST_KEY }]
    });

    const res = await asImg(`/api/media/posts/${POST_KEY}`, token());
    expect(res.status).toBe(302);
  });

  it('REGRESSION: a private post is not', async () => {
    setup({
      posts: [{ id: 'p1', author_id: OWNER, is_public: false }],
      post_media: [{ id: 'pm1', post_id: 'p1', storage_key: POST_KEY }]
    });

    const res = await asImg(`/api/media/posts/${POST_KEY}`, token());

    expect(res.status).toBe(403);
    expect(res.headers.location).toBeUndefined();
  });

  it('the author can still see their own private post media', async () => {
    setup({
      posts: [{ id: 'p1', author_id: OWNER, is_public: false }],
      post_media: [{ id: 'pm1', post_id: 'p1', storage_key: POST_KEY }]
    });

    const res = await asImg(`/api/media/posts/${POST_KEY}`, signMediaToken(OWNER));
    expect(res.status).toBe(302);
  });

  it('REGRESSION: a blocked viewer cannot see the blocker\'s post media', async () => {
    setup({
      posts: [{ id: 'p1', author_id: OWNER, is_public: true }],
      post_media: [{ id: 'pm1', post_id: 'p1', storage_key: POST_KEY }],
      blocks: [{ id: 'b1', blocker_id: OWNER, blocked_id: VIEWER }]
    });

    const res = await asImg(`/api/media/posts/${POST_KEY}`, token());
    expect(res.status).toBe(403);
  });

  it('REGRESSION: an object nothing points at is not handed out', async () => {
    // No post_media row: an orphan, or an upload still in flight. Either way
    // it is not something anyone has been granted.
    setup();
    const res = await asImg(`/api/media/posts/${POST_KEY}`, token());
    expect(res.status).toBe(403);
  });
});

describe('stored URLs are proxy paths, never public bucket URLs', () => {
  it('REGRESSION: mediaPath never produces an /object/public/ URL', () => {
    const url = mediaPath('avatars', AVATAR_KEY);

    expect(url).toBe(`/api/media/avatars/${AVATAR_KEY}`);
    expect(url).not.toContain('/object/public/');
    // Relative on purpose: the client reaches the API same-origin through the
    // rewrites, which is what lets the cookie be sent at all.
    expect(url.startsWith('/')).toBe(true);
  });
});

describe('ownerOf, directly', () => {
  /*
   * Tested as a unit rather than through the route, because the route cannot
   * reach one of its branches and a test that pretends otherwise is worse than
   * no test.
   *
   * A mutation run found this: deleting the `..` check failed nothing. Express
   * normalises `../` before routing, and supertest normalises it again before
   * sending, so a traversal always arrives with the wrong number of segments
   * and is refused by the shape check instead. I confirmed the mutation really
   * applied -- ownerOf returned '..' -- and the route test still passed.
   *
   * So the traversal check is defence in depth, not the primary control. That
   * is worth keeping (a future caller may not be an Express route, and
   * normalisation is a property of the transport rather than a guarantee), and
   * worth testing where it is actually reachable.
   */
  const { __ownerOf } = require('../routes/media.js');

  it('extracts the owner from a well-formed key', () => {
    expect(__ownerOf(`users/${OWNER}/avatar/x.webp`, 'avatar')).toBe(OWNER);
  });

  it('REGRESSION: refuses a four-segment key containing a traversal', () => {
    // Passes the segment-count and prefix checks -- 'users' first, 'avatar'
    // third -- so only the `..` check stands between this and a signed URL for
    // a path outside the user's own prefix.
    expect(__ownerOf('users/../avatar/x.webp', 'avatar')).toBeNull();
  });

  it('REGRESSION: refuses an absolute key', () => {
    expect(__ownerOf('/users/x/avatar/y.webp', 'avatar')).toBeNull();
  });

  it('refuses a key whose kind segment does not match the bucket', () => {
    expect(__ownerOf(`users/${OWNER}/post/x.jpg`, 'avatar')).toBeNull();
  });

  it('refuses shapes we never write', () => {
    for (const bad of ['', 'etc/passwd', `users/${OWNER}/avatar`, `a/b/c/d/e`, null]) {
      expect(__ownerOf(bad, 'avatar')).toBeNull();
    }
  });
});
