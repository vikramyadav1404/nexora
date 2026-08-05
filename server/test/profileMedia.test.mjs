/**
 * Avatar and cover upload.
 *
 * Same createRequire setup as the other suites — see subscriptions.test.mjs for
 * why `import` is not used for server modules.
 *
 * Nothing here touches Cloudflare, Supabase or the network. The fake client
 * carries an in-memory bucket, and global fetch is stubbed to read from it so
 * the ranged magic-byte check exercises real code without leaving the process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

process.env.JWT_SECRET = 'test_jwt_secret';
process.env.SUPABASE_URL = 'https://fake.supabase.co';

const require = createRequire(import.meta.url);
const { __setTestClient } = require('../db/supabase.js');
const { setMediaColumnSupport } = require('../db/helpers.js');
const jwt = require('jsonwebtoken');

const USER = {
  id: '00000000-0000-4000-8000-0000000000aa',
  name: 'Tester',
  email: 'tester@nexora.test',
  avatar: '',
  avatar_key: '',
  avatar_thumb_url: '',
  cover_url: '',
  cover_key: '',
  points: 10,
  is_active: true
};
const PEER = { ...USER, id: '00000000-0000-4000-8000-0000000000bb', email: 'peer@nexora.test' };

/** Smallest byte sequences that satisfy each format sniffer. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1)
]);
const NOT_AN_IMAGE = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');

let db;
const token = (id = USER.id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/uploads', require('../routes/uploads.js'));
  a.use('/api/users', require('../routes/users.js'));
  return a;
}

beforeEach(() => {
  db = createFakeSupabase({ users: [{ ...USER }, { ...PEER }] });
  __setTestClient(db);
  process.env.NODE_ENV = 'test';

  // index.js probes for migration 008 at boot; these suites mount routes
  // directly, so declare support explicitly. The gate itself is covered below.
  setMediaColumnSupport(true);

  // readRange() signs a URL then fetches it with a Range header. Serve those
  // reads out of the fake bucket instead of the network.
  vi.stubGlobal('fetch', async (url, opts = {}) => {
    const match = String(url).match(/\/read\/([^/]+)\/(.+)$/);
    if (!match) return { ok: false, status: 404 };
    const obj = db._objects.get(`${match[1]}/${decodeURIComponent(match[2])}`);
    if (!obj) return { ok: false, status: 404 };

    const range = String(opts.headers?.Range || '').match(/bytes=(\d+)-(\d+)/);
    const slice = range
      ? obj.buffer.subarray(Number(range[1]), Number(range[2]) + 1)
      : obj.buffer;
    return { ok: true, status: 206, arrayBuffer: async () => slice };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const presign = (body, as = USER.id) =>
  request(app())
    .post('/api/uploads/presign')
    .set('Authorization', `Bearer ${token(as)}`)
    .send(body);

const attach = (kind, body, as = USER.id) =>
  request(app())
    .patch(`/api/users/me/${kind}`)
    .set('Authorization', `Bearer ${token(as)}`)
    .send(body);

describe('POST /api/uploads/presign', () => {
  it('mints a ticket for an allowed image type', async () => {
    const res = await presign({ kind: 'avatar', mimeType: 'image/jpeg', size: 1024 });

    expect(res.status).toBe(200);
    expect(res.body.signedUrl).toContain('avatars/');
    // The key is generated server-side and namespaced to the caller.
    expect(res.body.key).toMatch(new RegExp(`^users/${USER.id}/avatar/[0-9a-f-]+\\.jpg$`));
  });

  it('rejects disallowed mime types, SVG included', async () => {
    for (const mimeType of ['image/svg+xml', 'text/html', 'application/pdf', 'image/gif']) {
      const res = await presign({ kind: 'avatar', mimeType, size: 1024 });
      expect(res.status).toBe(400);
    }
  });

  it('rejects a declared size over the per-kind limit', async () => {
    const avatar = await presign({ kind: 'avatar', mimeType: 'image/png', size: 6 * 1024 * 1024 });
    expect(avatar.status).toBe(413);

    // Covers get a larger allowance, so the same size is fine there.
    const cover = await presign({ kind: 'cover', mimeType: 'image/png', size: 6 * 1024 * 1024 });
    expect(cover.status).toBe(200);

    const tooBig = await presign({ kind: 'cover', mimeType: 'image/png', size: 9 * 1024 * 1024 });
    expect(tooBig.status).toBe(413);
  });

  it('rejects an unknown kind', async () => {
    const res = await presign({ kind: 'banner', mimeType: 'image/png', size: 1024 });
    expect(res.status).toBe(400);
  });

  it('never lets the client choose the object key', async () => {
    const res = await presign({
      kind: 'avatar',
      mimeType: 'image/png',
      size: 1024,
      key: '../../etc/passwd'
    });

    expect(res.status).toBe(200);
    expect(res.body.key).not.toContain('..');
    expect(res.body.key.startsWith(`users/${USER.id}/`)).toBe(true);
  });
});

describe('PATCH /api/users/me/avatar', () => {
  it('attaches an uploaded object and stores its key', async () => {
    const key = `users/${USER.id}/avatar/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg`;
    db._seedObject('avatars', key, JPEG, 'image/jpeg');

    const res = await attach('avatar', { key });

    expect(res.status).toBe(200);
    const row = db._tables.users.find(u => u.id === USER.id);
    expect(row.avatar_key).toBe(key);
    expect(row.avatar).toContain(key);
  });

  it('IDOR: refuses a key namespaced to another user', async () => {
    // PEER really did upload this — the object exists. The only thing stopping
    // USER from claiming it is the prefix check.
    const peerKey = `users/${PEER.id}/avatar/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg`;
    db._seedObject('avatars', peerKey, JPEG, 'image/jpeg');

    const res = await attach('avatar', { key: peerKey });

    expect(res.status).toBe(403);
    expect(db._tables.users.find(u => u.id === USER.id).avatar_key).toBe('');
  });

  it('refuses a traversal key that would escape the user prefix', async () => {
    const res = await attach('avatar', { key: `users/${USER.id}/avatar/../../${PEER.id}/avatar/x.jpg` });
    expect(res.status).toBe(403);
  });

  it('refuses a key with no object behind it', async () => {
    const res = await attach('avatar', {
      key: `users/${USER.id}/avatar/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg`
    });

    expect(res.status).toBe(404);
    expect(db._tables.users.find(u => u.id === USER.id).avatar_key).toBe('');
  });

  it('refuses an object whose bytes are not a real image', async () => {
    // Uploaded through a ticket that declared image/png, but the content is SVG.
    // Only the magic-byte read catches this.
    const key = `users/${USER.id}/avatar/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png`;
    db._seedObject('avatars', key, NOT_AN_IMAGE, 'image/png');

    const res = await attach('avatar', { key });

    expect(res.status).toBe(400);
    expect(db._tables.users.find(u => u.id === USER.id).avatar_key).toBe('');
  });

  it('refuses an object larger than the limit even though presign passed', async () => {
    const key = `users/${USER.id}/avatar/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png`;
    // Declared 1KB at presign, actually 6MB on the bucket.
    db._seedObject('avatars', key, Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]), 'image/png');

    const res = await attach('avatar', { key });
    expect(res.status).toBe(413);
  });

  it('deletes the previous object when the avatar is replaced', async () => {
    const oldKey = `users/${USER.id}/avatar/11111111-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg`;
    const newKey = `users/${USER.id}/avatar/22222222-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg`;
    db._seedObject('avatars', oldKey, JPEG, 'image/jpeg');
    db._seedObject('avatars', newKey, JPEG, 'image/jpeg');
    db._tables.users.find(u => u.id === USER.id).avatar_key = oldKey;

    const res = await attach('avatar', { key: newKey });

    expect(res.status).toBe(200);
    const removed = db._storageCalls.filter(c => c.op === 'remove').map(c => c.key);
    expect(removed).toContain(oldKey);
    // And the replacement survived the cleanup.
    expect(db._objects.has(`avatars/${newKey}`)).toBe(true);
  });
});

describe('PATCH /api/users/me/cover', () => {
  it('attaches a cover independently of the avatar', async () => {
    const key = `users/${USER.id}/cover/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png`;
    db._seedObject('covers', key, PNG, 'image/png');

    const res = await attach('cover', { key });

    expect(res.status).toBe(200);
    const row = db._tables.users.find(u => u.id === USER.id);
    expect(row.cover_key).toBe(key);
    expect(row.avatar_key).toBe('');
  });

  it('IDOR: refuses an avatar key submitted to the cover endpoint', async () => {
    // Right owner, wrong kind — the prefix check covers both dimensions.
    const key = `users/${USER.id}/avatar/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png`;
    db._seedObject('avatars', key, PNG, 'image/png');

    const res = await attach('cover', { key });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/users/me/:kind', () => {
  it('clears the fields and removes the object', async () => {
    const key = `users/${USER.id}/avatar/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg`;
    db._seedObject('avatars', key, JPEG, 'image/jpeg');
    const row = db._tables.users.find(u => u.id === USER.id);
    row.avatar_key = key;
    row.avatar = `https://fake.supabase.co/storage/v1/object/public/avatars/${key}`;

    const res = await request(app())
      .delete('/api/users/me/avatar')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    expect(row.avatar).toBe('');
    expect(row.avatar_key).toBe('');
    expect(db._objects.has(`avatars/${key}`)).toBe(false);
  });
});

describe('PUT /api/users/profile no longer takes images', () => {
  it('saves text fields sent as JSON', async () => {
    const res = await request(app())
      .put('/api/users/profile')
      .set('Authorization', `Bearer ${token()}`)
      .send({ firstName: 'New', lastName: 'Name', bio: 'hello' });

    expect(res.status).toBe(200);
    expect(db._tables.users.find(u => u.id === USER.id).name).toBe('New Name');
  });

  it('rejects a multipart body instead of silently ignoring it', async () => {
    // The old route took `upload.single('avatar')`. Now express.json() would
    // leave req.body empty and the update would be a no-op returning 200 —
    // a stale caller would look like it worked.
    const res = await request(app())
      .put('/api/users/profile')
      .set('Authorization', `Bearer ${token()}`)
      .field('bio', 'via multipart')
      .attach('avatar', JPEG, 'a.jpg');

    expect(res.status).toBe(415);
    expect(res.body.message).toMatch(/uploads\/presign/);
    expect(db._tables.users.find(u => u.id === USER.id).bio).not.toBe('via multipart');
  });
});

describe('degrades when migration 008 has not been applied', () => {
  beforeEach(() => setMediaColumnSupport(false));
  afterEach(() => setMediaColumnSupport(true));

  it('presign returns 503 rather than orphaning an upload', async () => {
    // Without the columns there is nowhere to record the key, so an upload
    // would land in the bucket and never be referenced by anything.
    const res = await presign({ kind: 'avatar', mimeType: 'image/png', size: 1024 });
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/not enabled/i);
  });

  it('attach returns 503 instead of a Postgres column error', async () => {
    const key = `users/${USER.id}/avatar/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg`;
    db._seedObject('avatars', key, JPEG, 'image/jpeg');
    const res = await attach('avatar', { key });
    expect(res.status).toBe(503);
  });

  it('author select lists omit the missing column so reads keep working', async () => {
    const { authorFields, withMediaColumns } = require('../db/helpers.js');
    expect(authorFields()).not.toContain('avatar_thumb_url');
    expect(withMediaColumns('id, name, avatar')).toBe('id, name, avatar');

    setMediaColumnSupport(true);
    expect(authorFields()).toContain('avatar_thumb_url');
    expect(withMediaColumns('id, name, avatar', { cover: true }))
      .toBe('id, name, avatar, avatar_thumb_url, cover_url');
  });
});

describe('authentication', () => {
  const endpoints = [
    ['post', '/api/uploads/presign'],
    ['patch', '/api/users/me/avatar'],
    ['patch', '/api/users/me/cover'],
    ['delete', '/api/users/me/avatar'],
    ['delete', '/api/users/me/cover']
  ];

  it.each(endpoints)('%s %s rejects an unauthenticated request', async (method, path) => {
    const res = await request(app())[method](path).send({});
    expect(res.status).toBe(401);
  });

  it.each(endpoints)('%s %s rejects a forged token', async (method, path) => {
    const forged = jwt.sign({ id: USER.id }, 'wrong_secret', { expiresIn: '1h' });
    const res = await request(app())[method](path).set('Authorization', `Bearer ${forged}`).send({});
    expect(res.status).toBe(401);
  });
});
