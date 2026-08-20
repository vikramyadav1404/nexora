/**
 * The nightly orphan-media sweep.
 *
 * routes/cron.js had no test file at all, which is the wrong way round: this is
 * the only unattended job in the codebase that deletes things, it runs at 03:00
 * every night against production storage, and nothing it removes comes back.
 *
 * Two defects lived here, both the same shape -- the code assumed something
 * about the world that stopped being true, and nothing checked:
 *
 *   1. It resolved the live-keys column with
 *        kind === 'avatar' ? 'avatar_key' : 'cover_key'
 *      which was right while there were two media kinds. A third, 'post', was
 *      added to KIND_CONFIG later and silently resolved to cover_key -- so post
 *      objects were compared against cover keys, never matched, and every post
 *      attachment was deleted the night after it was uploaded.
 *
 *   2. The live-key query discarded its error. One statement timeout produced
 *      an empty set, and an empty set means everything looks orphaned: every
 *      avatar and cover on the platform.
 *
 * So these tests are mostly about what must NOT be deleted.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

const require = createRequire(import.meta.url);
const { __setTestClient } = require('../db/supabase.js');
const { __sweepOrphanedMedia: sweep } = require('../routes/cron.js');
const { KIND_CONFIG } = require('../utils/mediaStorage.js');

const USER = '00000000-0000-4000-8000-000000000001';
const HOURS = 60 * 60 * 1000;

let db;

/** Put an object in a bucket with an explicit age. */
function seedObject(bucket, key, ageMs = 5 * HOURS) {
  db._objects.set(`${bucket}/${key}`, {
    buffer: Buffer.from('x'),
    contentType: 'image/webp',
    created_at: new Date(Date.now() - ageMs).toISOString()
  });
}

const exists = (bucket, key) => db._objects.has(`${bucket}/${key}`);

function setup(seed = {}) {
  db = createFakeSupabase({
    users: [{ id: USER, avatar_key: '', cover_key: '' }],
    post_media: [],
    ...seed
  });
  __setTestClient(db);
}

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  setup();
});

describe('post attachments', () => {
  it('REGRESSION: an attachment recorded in post_media survives', async () => {
    const key = `users/${USER}/post/aaaaaaaa-1111-4000-8000-000000000001.jpg`;
    setup({ post_media: [{ id: 'pm1', post_id: 'p1', storage_key: key, url: 'u' }] });
    seedObject('posts', key);

    await sweep();

    // Before the fix this was judged against the set of COVER keys, matched
    // nothing by construction, and was deleted.
    expect(exists('posts', key)).toBe(true);
  });

  it('an object with no post_media row is removed once past the grace window', async () => {
    const orphan = `users/${USER}/post/bbbbbbbb-2222-4000-8000-000000000002.jpg`;
    setup();
    seedObject('posts', orphan);

    await sweep();

    expect(exists('posts', orphan)).toBe(false);
  });

  it('an upload still in flight is left alone', async () => {
    const fresh = `users/${USER}/post/cccccccc-3333-4000-8000-000000000003.jpg`;
    setup();
    seedObject('posts', fresh, 10 * 60 * 1000);

    await sweep();

    expect(exists('posts', fresh)).toBe(true);
  });
});

describe('profile media', () => {
  it('an avatar a user row points at survives, and so does its thumbnail', async () => {
    const key = `users/${USER}/avatar/dddddddd-4444-4000-8000-000000000004.webp`;
    const thumb = key.replace(/\.webp$/, '-128.webp');
    setup({ users: [{ id: USER, avatar_key: key, cover_key: '' }] });
    seedObject('avatars', key);
    seedObject('avatars', thumb);

    await sweep();

    expect(exists('avatars', key)).toBe(true);
    expect(exists('avatars', thumb)).toBe(true);
  });

  it('a cover a user row points at survives', async () => {
    const key = `users/${USER}/cover/eeeeeeee-5555-4000-8000-000000000005.webp`;
    setup({ users: [{ id: USER, avatar_key: '', cover_key: key }] });
    seedObject('covers', key);

    await sweep();

    expect(exists('covers', key)).toBe(true);
  });

  it('REGRESSION: post objects are never judged against cover keys', async () => {
    /*
     * The confusion stated directly: a user with a cover set and a post
     * attachment. The post key is not among the cover keys, and before the fix
     * that alone condemned it.
     */
    const cover = `users/${USER}/cover/ffffffff-6666-4000-8000-000000000006.webp`;
    const post = `users/${USER}/post/99999999-7777-4000-8000-000000000007.jpg`;
    setup({
      users: [{ id: USER, avatar_key: '', cover_key: cover }],
      post_media: [{ id: 'pm2', post_id: 'p2', storage_key: post, url: 'u' }]
    });
    seedObject('covers', cover);
    seedObject('posts', post);

    await sweep();

    expect(exists('covers', cover)).toBe(true);
    expect(exists('posts', post)).toBe(true);
  });
});

describe('failing safe', () => {
  it('REGRESSION: if the live-key lookup errors, nothing at all is deleted', async () => {
    const avatar = `users/${USER}/avatar/11111111-8888-4000-8000-000000000008.webp`;
    const post = `users/${USER}/post/22222222-9999-4000-8000-000000000009.jpg`;
    setup({ users: [{ id: USER, avatar_key: avatar, cover_key: '' }] });
    seedObject('avatars', avatar);
    seedObject('posts', post);

    // A statement timeout on the live-key query. The error used to be
    // destructured away, so `live` came back empty -- and an empty live set
    // means every object on the platform looks orphaned.
    const realFrom = db.from.bind(db);
    db.from = (table) => {
      if (table === 'users' || table === 'post_media') {
        return {
          select: () => ({
            neq: () => ({
              range: () => Promise.resolve({
                data: null,
                error: { code: '57014', message: 'canceling statement due to statement timeout' }
              })
            })
          })
        };
      }
      return realFrom(table);
    };

    await expect(sweep()).rejects.toThrow(/live-key lookup failed/i);

    expect(exists('avatars', avatar)).toBe(true);
    expect(exists('posts', post)).toBe(true);
    expect(db._storageCalls.some(c => c.op === 'remove')).toBe(false);
  });

  it('a kind with no known live-key source is skipped, not guessed', async () => {
    KIND_CONFIG.banner = { bucket: 'banners', maxBytes: 1024 };
    try {
      const key = `users/${USER}/banner/33333333-aaaa-4000-8000-00000000000a.webp`;
      setup();
      seedObject('banners', key);

      const result = await sweep();

      // Skipping leaks an orphan. Guessing a column deletes live files. Only
      // one of those can be undone.
      expect(exists('banners', key)).toBe(true);
      expect(result.skipped).toContain('banner');
    } finally {
      delete KIND_CONFIG.banner;
    }
  });
});

describe('paging the live set', () => {
  it('REGRESSION: a live key beyond the first page is still protected', async () => {
    /*
     * PostgREST caps a response. Reading one page and calling it the whole live
     * set means everything past the cap is deleted -- the same failure as the
     * discarded error, reached a different way.
     */
    const users = [];
    const keys = [];
    for (let i = 0; i < 1200; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const key = `users/${id}/avatar/a${i}.webp`;
      users.push({ id, avatar_key: key, cover_key: '' });
      keys.push(key);
    }
    setup({ users });
    // Seed only the one past the first page of 1000.
    seedObject('avatars', keys[1150]);

    await sweep();

    expect(exists('avatars', keys[1150])).toBe(true);
  });
});
