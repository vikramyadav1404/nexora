/**
 * The dry run and the circuit breaker.
 *
 * The sweep could previously only delete. Both times it was wrong it deleted
 * nearly everything it scanned -- the `cover_key` ternary made post attachments
 * unmatched by construction, and the discarded error emptied the live set so
 * nothing matched at all. Both were caught by reading the code afterwards.
 *
 * Two changes, tested here. A dry run reports what it would remove and removes
 * nothing, so a human can look before the nightly job is trusted. And a breaker
 * refuses any run that wants to delete more than a quarter of what it scanned,
 * which is the shape both historical bugs had -- so a third bug of that shape
 * becomes a report instead of an outage.
 *
 * The dry-run assertions check the *storage*, never the return value. A
 * function that says `removed: 0` while deleting is exactly the failure a dry
 * run exists to prevent, and asserting on its own report would not notice.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

const require = createRequire(import.meta.url);
const { __setTestClient } = require('../db/supabase.js');
const { __sweepOrphanedMedia: sweep } = require('../routes/cron.js');

const USER = '00000000-0000-4000-8000-000000000001';
const HOURS = 60 * 60 * 1000;

let db;

function seedObject(bucket, key, ageMs = 5 * HOURS) {
  db._objects.set(`${bucket}/${key}`, {
    buffer: Buffer.from('x'),
    contentType: 'image/webp',
    created_at: new Date(Date.now() - ageMs).toISOString()
  });
}

const exists = (bucket, key) => db._objects.has(`${bucket}/${key}`);
const objectCount = () => db._objects.size;

function setup(seed = {}) {
  db = createFakeSupabase({
    users: [{ id: USER, avatar_key: '', cover_key: '' }],
    post_media: [],
    ...seed
  });
  __setTestClient(db);
}

/** n orphaned post objects, all past the grace window. */
function seedOrphans(n) {
  const keys = [];
  for (let i = 0; i < n; i += 1) {
    const key = `users/${USER}/post/${String(i).padStart(8, '0')}-1111-4000-8000-000000000001.jpg`;
    seedObject('posts', key);
    keys.push(key);
  }
  return keys;
}

/** m live post objects, each with a row pointing at it. */
function seedLive(m) {
  const rows = [];
  for (let i = 0; i < m; i += 1) {
    const key = `users/${USER}/post/live${String(i).padStart(4, '0')}-1111-4000-8000-000000000002.jpg`;
    rows.push({ id: `pm${i}`, post_id: `p${i}`, storage_key: key, url: 'u' });
  }
  setup({ post_media: rows });
  for (const r of rows) seedObject('posts', r.storage_key);
  return rows.map(r => r.storage_key);
}

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  setup();
});

describe('the dry run', () => {
  it('REGRESSION: deletes nothing', async () => {
    seedOrphans(3);
    const before = objectCount();

    const result = await sweep({ dryRun: true });

    // The storage, not the report. A sweep that claimed removed:0 while
    // deleting is precisely what a dry run must not be trusted about.
    expect(objectCount()).toBe(before);
    expect(result.removed).toBe(0);
  });

  it('names the keys it would remove, not just a count', async () => {
    // A count is not reviewable. The point of running this against production
    // is to read the list and judge whether it looks right.
    const keys = seedOrphans(2);
    const result = await sweep({ dryRun: true });

    expect(result.candidates).toBe(2);
    expect(result.keys.map(k => k.key).sort()).toEqual(keys.sort());
    expect(result.keys[0].reason).toMatch(/post_media\.storage_key/);
    expect(result.keys[0].ageHours).toBeGreaterThanOrEqual(4);
  });

  it('REGRESSION: reports exactly what a real run then deletes', async () => {
    /*
     * The property that makes a dry run worth anything. If the two disagreed,
     * reviewing the dry output would be theatre -- you would be approving one
     * list and getting another.
     */
    const keys = seedOrphans(3);
    const dry = await sweep({ dryRun: true });

    const wet = await sweep({ dryRun: false });

    expect(wet.removed).toBe(dry.candidates);
    expect(wet.keys.map(k => k.key).sort()).toEqual(dry.keys.map(k => k.key).sort());
    for (const key of keys) expect(exists('posts', key)).toBe(false);
  });

  it('leaves live objects out of the list entirely', async () => {
    const live = seedLive(2);
    const result = await sweep({ dryRun: true });

    expect(result.candidates).toBe(0);
    for (const key of live) expect(exists('posts', key)).toBe(true);
  });
});

describe('the circuit breaker', () => {
  it('REGRESSION: refuses a run that would delete most of what it scanned', async () => {
    /*
     * The shape of both historical bugs. 12 orphans out of 12 scanned is 100%,
     * over the 25% ceiling and over the floor of 10.
     */
    seedOrphans(12);
    const before = objectCount();

    const result = await sweep({ dryRun: false });

    expect(result.aborted).toBe(true);
    expect(result.removed).toBe(0);
    expect(objectCount()).toBe(before);
    expect(result.reason).toMatch(/ceiling|refusing/i);
  });

  it('REGRESSION: the historical bug would have tripped it', async () => {
    /*
     * Reproduces defect 2 directly: an empty live set means everything looks
     * orphaned. 20 objects, all referenced, but the live lookup returns nothing.
     * Before the breaker this deleted all 20.
     */
    const live = seedLive(20);
    // Simulate the discarded-error outcome: rows exist in storage, none in the
    // table the sweep consults.
    db._tables.post_media.length = 0;

    const result = await sweep({ dryRun: false });

    expect(result.aborted).toBe(true);
    for (const key of live) expect(exists('posts', key)).toBe(true);
  });

  it('does not trip on a small number of genuine orphans', async () => {
    /*
     * Why the floor exists. 3 of 3 is 100% and completely normal -- ratios say
     * nothing at small n, and a breaker that fires constantly gets forced past
     * until nobody reads it.
     */
    seedOrphans(3);
    const result = await sweep({ dryRun: false });

    expect(result.aborted).toBeUndefined();
    expect(result.removed).toBe(3);
  });

  it('does not trip when most of what was scanned is live', async () => {
    // 20 live, 2 orphaned: 2 of 22 is well under the ceiling.
    seedLive(20);
    const orphans = seedOrphans(2);

    const result = await sweep({ dryRun: false });

    expect(result.aborted).toBeUndefined();
    expect(result.removed).toBe(2);
    for (const key of orphans) expect(exists('posts', key)).toBe(false);
  });

  it('force proceeds, for the case where a lot really is orphaned', async () => {
    const keys = seedOrphans(12);
    const result = await sweep({ dryRun: false, force: true });

    expect(result.aborted).toBeUndefined();
    expect(result.removed).toBe(12);
    for (const key of keys) expect(exists('posts', key)).toBe(false);
  });

  it('REGRESSION: force does not override dryRun', async () => {
    // The two flags answer different questions. `force` says "yes, this many is
    // correct"; it must not also mean "and delete them now".
    seedOrphans(12);
    const before = objectCount();

    const result = await sweep({ dryRun: true, force: true });

    expect(result.removed).toBe(0);
    expect(objectCount()).toBe(before);
  });

  it('reports the candidate list even when it aborts', async () => {
    // Aborting without saying what it saw would leave nothing to diagnose.
    seedOrphans(12);
    const result = await sweep({ dryRun: false });

    expect(result.keys).toHaveLength(12);
    expect(result.scanned).toBe(12);
  });
});

describe('the nightly job still works', () => {
  it('deletes orphans below the ceiling, as it always did', async () => {
    seedLive(20);
    const orphan = seedOrphans(1)[0];

    // The shape /daily calls.
    const result = await sweep({ dryRun: false });

    expect(result.removed).toBe(1);
    expect(exists('posts', orphan)).toBe(false);
  });
});
