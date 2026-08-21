/**
 * Feed attachments uploaded direct to storage.
 *
 * The composer has always advertised 50MB, but multipart posts went through the
 * serverless function, which rejects a request body over roughly 4.5MB at the
 * edge. Any real phone photo failed. Attachments now take the same signed-URL
 * route profile media already uses: the browser PUTs to storage and the API is
 * handed only a key.
 *
 * That moves the entire trust boundary into verifyPostUpload, because a signed
 * Supabase upload URL — unlike an S3 presigned POST — cannot carry
 * Content-Length or Content-Type conditions. Between minting a ticket and
 * attaching it, the client controls the bytes completely. These tests are what
 * hold that boundary in place.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

process.env.JWT_SECRET = 'test_jwt_secret';

const require = createRequire(import.meta.url);
const { __setTestClient } = require('../db/supabase.js');
const { setMediaColumnSupport } = require('../db/helpers.js');
const jwt = require('jsonwebtoken');

const USER = {
  id: '00000000-0000-4000-8000-0000000000a1',
  name: 'Poster',
  email: 'poster@nexora.test',
  is_active: true,
  points: 0,
  interests: ['technology'],
  posts_today: 0
};

const PEER = { ...USER, id: '00000000-0000-4000-8000-0000000000b2', email: 'peer@nexora.test' };

/** Real magic bytes — the whole point is that these are not trusted labels. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(28, 1)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)
]);
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42', 'ascii'), Buffer.alloc(20, 1)
]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>'.padEnd(64, ' '));

let db;
const token = (id = USER.id) => jwt.sign({ id, typ: 'access' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const keyFor = (userId, ext = 'webp') => `users/${userId}/post/${crypto.randomUUID()}.${ext}`;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/posts', require('../routes/posts.js'));
  a.use('/api/uploads', require('../routes/uploads.js'));
  return a;
}

beforeEach(() => {
  db = createFakeSupabase({
    users: [{ ...USER }, { ...PEER }],
    posts: [],
    post_media: [],
    // A follow each, so getDailyPostLimit does not refuse the post outright.
    follows: [
      { follower_id: USER.id, following_id: PEER.id },
      { follower_id: PEER.id, following_id: USER.id }
    ]
  });
  __setTestClient(db);
  process.env.NODE_ENV = 'test';
  setMediaColumnSupport(true);

  // readRange signs a URL then fetches it with a Range header. Serve those out
  // of the fake bucket instead of the network.
  vi.stubGlobal('fetch', async (url, opts = {}) => {
    // The fake signs URLs the way Supabase does: /object/sign/<bucket>/<key>?token=…
    const match = String(url).match(/\/object\/sign\/([^/]+)\/(.+?)(?:\?|$)/);
    if (!match) return { ok: false, status: 404 };
    const obj = db._objects.get(`${match[1]}/${decodeURIComponent(match[2])}`);
    if (!obj) return { ok: false, status: 404 };
    const range = String(opts.headers?.Range || '').match(/bytes=(\d+)-(\d+)/);
    const slice = range ? obj.buffer.subarray(Number(range[1]), Number(range[2]) + 1) : obj.buffer;
    return { ok: true, status: 206, arrayBuffer: async () => slice };
  });
});

afterEach(() => vi.unstubAllGlobals());

const post = (body, as = USER.id) =>
  request(app()).post('/api/posts').set('Authorization', `Bearer ${token(as)}`).send(body);

describe('presign accepts post attachments', () => {
  it('mints a ticket for an image', async () => {
    const res = await request(app())
      .post('/api/uploads/presign')
      .set('Authorization', `Bearer ${token()}`)
      .send({ kind: 'post', mimeType: 'image/webp', size: 1024 });

    expect(res.status).toBe(200);
    expect(res.body.bucket).toBe('posts');
    expect(res.body.key).toMatch(new RegExp(`^users/${USER.id}/post/`));
  });

  it('mints a ticket for video, which profile media never allows', async () => {
    const asPost = await request(app()).post('/api/uploads/presign')
      .set('Authorization', `Bearer ${token()}`)
      .send({ kind: 'post', mimeType: 'video/mp4', size: 1024 });
    expect(asPost.status).toBe(200);

    // The same type as an avatar must still be refused — widening the post
    // allowlist must not quietly widen the profile one.
    const asAvatar = await request(app()).post('/api/uploads/presign')
      .set('Authorization', `Bearer ${token()}`)
      .send({ kind: 'avatar', mimeType: 'video/mp4', size: 1024 });
    expect(asAvatar.status).toBe(400);
  });

  it('refuses a declared size over 50MB before anything is uploaded', async () => {
    const res = await request(app()).post('/api/uploads/presign')
      .set('Authorization', `Bearer ${token()}`)
      .send({ kind: 'post', mimeType: 'image/webp', size: 51 * 1024 * 1024 });
    expect(res.status).toBe(413);
  });
});

describe('POST /api/posts with mediaKeys', () => {
  it('creates the post and records the storage key', async () => {
    const key = keyFor(USER.id, 'jpg');
    db._seedObject('posts', key, JPEG, 'image/jpeg');

    const res = await post({ content: 'hello', mediaKeys: [key] });

    expect(res.status).toBe(201);
    expect(res.body.post.media).toHaveLength(1);
    expect(res.body.post.media[0].type).toBe('image');

    const row = db._tables.post_media[0];
    expect(row.storage_key).toBe(key);
    expect(row.url).toContain(key);
  });

  it('accepts a video and types it correctly from its bytes', async () => {
    const key = keyFor(USER.id, 'mp4');
    db._seedObject('posts', key, MP4, 'video/mp4');

    const res = await post({ mediaKeys: [key] });
    expect(res.status).toBe(201);
    expect(db._tables.post_media[0].type).toBe('video');
  });

  it('accepts several attachments in one post', async () => {
    const keys = ['jpg', 'png'].map((ext) => keyFor(USER.id, ext));
    db._seedObject('posts', keys[0], JPEG, 'image/jpeg');
    db._seedObject('posts', keys[1], PNG, 'image/png');

    const res = await post({ mediaKeys: keys });
    expect(res.status).toBe(201);
    expect(db._tables.post_media).toHaveLength(2);
  });
});

describe('the trust boundary', () => {
  it('REGRESSION: refuses a key belonging to another user', async () => {
    // The one that matters. Keys are guessable in shape — `users/{id}/post/…` —
    // so without the ownership check any account could attach anyone's upload
    // to its own post, and the object is served from a public bucket.
    const peerKey = keyFor(PEER.id, 'jpg');
    db._seedObject('posts', peerKey, JPEG, 'image/jpeg');

    const res = await post({ mediaKeys: [peerKey] }, USER.id);

    expect(res.status).toBe(403);
    expect(db._tables.posts).toHaveLength(0);
    expect(db._tables.post_media).toHaveLength(0);
  });

  it('refuses a malformed or traversing key', async () => {
    for (const bad of ['../../etc/passwd', '/users/x/post/a.jpg', 'users/x/post/a.jpg', '']) {
      const res = await post({ mediaKeys: [bad] });
      expect(res.status).toBe(403);
    }
    expect(db._tables.posts).toHaveLength(0);
  });

  it('refuses a key with nothing uploaded behind it', async () => {
    // Ownership passes, so this proves the existence check is separate from it.
    const res = await post({ mediaKeys: [keyFor(USER.id, 'jpg')] });

    expect(res.status).toBe(404);
    expect(db._tables.posts).toHaveLength(0);
  });

  it('refuses an object larger than 50MB, whatever was declared at presign', async () => {
    // The size sent to presign is a courtesy check for the browser. This is the
    // number that counts, and it comes from storage.
    const key = keyFor(USER.id, 'jpg');
    const huge = Buffer.concat([JPEG, Buffer.alloc(51 * 1024 * 1024, 0)]);
    db._seedObject('posts', key, huge, 'image/jpeg');

    const res = await post({ mediaKeys: [key] });

    expect(res.status).toBe(413);
    expect(res.body.message).toMatch(/50MB/);
    expect(db._tables.posts).toHaveLength(0);
  });

  it('refuses an empty object', async () => {
    const key = keyFor(USER.id, 'jpg');
    db._seedObject('posts', key, Buffer.alloc(0), 'image/jpeg');

    const res = await post({ mediaKeys: [key] });
    expect(res.status).toBe(400);
  });

  it('REGRESSION: refuses a file whose bytes are not the media it claims', async () => {
    // HTML uploaded through a ticket signed for image/webp. The declared type
    // decided the key's extension and would decide the Content-Type it is
    // served with from a public origin, so only the bytes can be believed.
    const key = keyFor(USER.id, 'webp');
    db._seedObject('posts', key, HTML, 'image/webp');

    const res = await post({ mediaKeys: [key] });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not a supported image or video/i);
    expect(db._tables.posts).toHaveLength(0);
  });

  it('refuses real image bytes that disagree with the declared extension', async () => {
    // A JPEG uploaded under a ticket signed for video/mp4. Both are allowed
    // types, so this only fails if the extension is checked against the sniff.
    const key = keyFor(USER.id, 'mp4');
    db._seedObject('posts', key, JPEG, 'video/mp4');

    const res = await post({ mediaKeys: [key] });
    expect(res.status).toBe(400);
  });

  it('caps the number of attachments', async () => {
    const keys = Array.from({ length: 6 }, () => keyFor(USER.id, 'jpg'));
    keys.forEach((k) => db._seedObject('posts', k, JPEG, 'image/jpeg'));

    const res = await post({ mediaKeys: keys });
    expect(res.status).toBe(400);
    expect(db._tables.posts).toHaveLength(0);
  });

  it('rejects an unauthenticated attempt', async () => {
    const res = await request(app()).post('/api/posts').send({ mediaKeys: [] });
    expect(res.status).toBe(401);
  });
});

describe('backward compatibility', () => {
  it('a text-only post still works', async () => {
    const res = await post({ content: 'no media here' });
    expect(res.status).toBe(201);
    expect(db._tables.post_media).toHaveLength(0);
  });

  it('REGRESSION: the multipart path still creates a post', async () => {
    // Browsers running an older bundle still post this way. Removing the path
    // would break them mid-session.
    const res = await request(app())
      .post('/api/posts')
      .set('Authorization', `Bearer ${token()}`)
      .field('content', 'from an older client')
      .attach('media', JPEG, { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    expect(db._tables.posts).toHaveLength(1);
    // The old path never knew the object path, so these rows carry no key.
    expect(db._tables.post_media[0].storage_key).toBe('');
  });

  it('still refuses a post with neither content nor media', async () => {
    const res = await post({ content: '', mediaKeys: [] });
    expect(res.status).toBe(400);
  });
});
