/**
 * Query counts for list endpoints.
 *
 * These endpoints each used to issue a handful of queries *per row*. The feed
 * was fixed a while ago and given a comment saying so; bookmarks and Spaces kept
 * their own per-row copies and never were. Opening a Bookmarks page with twenty
 * saved posts cost roughly 120 round trips to PostgREST.
 *
 * A count is the only thing that actually catches this coming back. Response
 * shape tests pass just as happily against the slow version, which is exactly
 * why it survived two rounds of cleanup unnoticed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

process.env.JWT_SECRET = 'test_jwt_secret';

const require = createRequire(import.meta.url);
const { __setTestClient } = require('../db/supabase.js');
const jwt = require('jsonwebtoken');

const USER = {
  id: '00000000-0000-4000-8000-0000000000qc'.replace('qc', 'ac'),
  name: 'Query Counter',
  email: 'qc@nexora.test',
  is_active: true,
  points: 0,
  interests: ['technology']
};

let db;
let calls;

const token = () => jwt.sign({ id: USER.id, typ: 'access' }, process.env.JWT_SECRET, { expiresIn: '1h' });

function app(mount, mod) {
  const a = express();
  a.use(express.json());
  a.use(mount, require(mod));
  return a;
}

/** Wrap the fake client so every .from(table) is recorded. */
function counting(client) {
  calls = [];
  const realFrom = client.from.bind(client);
  client.from = (table) => {
    calls.push(table);
    return realFrom(table);
  };
  return client;
}

function seedPosts(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    author_id: USER.id,
    content: `post ${i}`,
    is_public: true,
    interest_tags: ['technology'],
    shares: 0,
    created_at: new Date(Date.now() - i * 1000).toISOString()
  }));
}

beforeEach(() => {
  process.env.NODE_ENV = 'test';
});

describe('GET /api/bookmarks', () => {
  it('costs the same number of queries for 20 saved posts as for 1', async () => {
    const counts = {};

    for (const n of [1, 20]) {
      db = counting(createFakeSupabase({
        users: [{ ...USER }],
        posts: seedPosts(n),
        bookmarks: seedPosts(n).map((p, i) => ({
          id: `b${i}`,
          user_id: USER.id,
          target_type: 'post',
          target_id: p.id,
          created_at: new Date().toISOString()
        }))
      }));
      __setTestClient(db);

      const res = await request(app('/api/bookmarks', '../routes/bookmarks.js'))
        .get('/api/bookmarks')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      expect(res.body.bookmarks).toHaveLength(n);
      counts[n] = calls.length;
    }

    // The old shape was 1 + n*(1 + 5). At n=20 that is 121; at n=1 it is 7.
    expect(counts[20]).toBe(counts[1]);
    expect(counts[20]).toBeLessThan(12);
  });

  it('keeps newest-first order and drops bookmarks whose post is gone', async () => {
    const posts = seedPosts(3);
    db = counting(createFakeSupabase({
      users: [{ ...USER }],
      posts: [posts[0], posts[2]], // posts[1] was deleted after being saved
      bookmarks: posts.map((p, i) => ({
        id: `b${i}`,
        user_id: USER.id,
        target_type: 'post',
        target_id: p.id,
        created_at: new Date(Date.now() - i * 1000).toISOString()
      }))
    }));
    __setTestClient(db);

    const res = await request(app('/api/bookmarks', '../routes/bookmarks.js'))
      .get('/api/bookmarks')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.body.bookmarks.map(b => b.id)).toEqual(['p0', 'p2']);
    expect(res.body.bookmarks.every(b => b.item)).toBe(true);
  });
});

describe('GET /api/spaces/:id', () => {
  it('does not grow its query count with the number of posts', async () => {
    const counts = {};

    for (const n of [1, 20]) {
      db = counting(createFakeSupabase({
        users: [{ ...USER }],
        posts: seedPosts(n),
        questions: []
      }));
      __setTestClient(db);

      const res = await request(app('/api/spaces', '../routes/spaces.js'))
        .get('/api/spaces/technology')
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      counts[n] = calls.length;
    }

    // Was 1 + n*3 for posts alone: 61 at n=20.
    expect(counts[20]).toBe(counts[1]);
  });

  it('still omits comments, which this page never renders', async () => {
    db = counting(createFakeSupabase({
      users: [{ ...USER }],
      posts: seedPosts(2),
      post_comments: [{ id: 'c1', post_id: 'p0', author_id: USER.id, content: 'hi' }],
      questions: []
    }));
    __setTestClient(db);

    const res = await request(app('/api/spaces', '../routes/spaces.js'))
      .get('/api/spaces/technology')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    // Shipping comments the page throws away costs a query and bandwidth.
    expect(calls).not.toContain('post_comments');
    expect(res.body.posts.every(p => (p.comments || []).length === 0)).toBe(true);
  });
});

describe('GET /api/posts', () => {
  it('stays flat as the page grows', async () => {
    const counts = {};

    for (const n of [1, 25]) {
      db = counting(createFakeSupabase({ users: [{ ...USER }], posts: seedPosts(n) }));
      __setTestClient(db);

      const res = await request(app('/api/posts', '../routes/posts.js'))
        .get(`/api/posts?limit=${n}`)
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      counts[n] = calls.length;
    }

    expect(counts[25]).toBe(counts[1]);
  });
});
