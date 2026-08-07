/**
 * Ranked search.
 *
 * Migration 007 shipped search_questions, search_posts and search_people with
 * tsvector columns, GIN indexes and ts_rank scoring — and nothing ever called
 * them. The route kept using ILIKE '%q%', which no index can serve because of
 * the leading wildcard, so every search was a sequential scan.
 *
 * The response shape is the constraint that shapes everything here. Search.jsx
 * reads { people, posts, questions, spaces, query } and the shapers need more
 * columns than search_people returns, so the ranking and the row fetch are two
 * separate steps. These tests exist mostly to hold that seam in place.
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

const ME = { id: '00000000-0000-4000-8000-0000000000e1', name: 'Me', email: 'me@nexora.test', is_active: true };
const ALICE = { id: '00000000-0000-4000-8000-0000000000e2', name: 'Alice Anderson', email: 'alice@nexora.test', is_active: true, avatar: '', points: 10, badges: [] };
const BOB = { id: '00000000-0000-4000-8000-0000000000e3', name: 'Bob Baker', email: 'bob@nexora.test', is_active: true, avatar: '', points: 5, badges: [] };

/** Object.keys().sort() order — 'query' precedes 'questions' ('quer' < 'ques'). */
const SHAPE_KEYS = ['people', 'posts', 'query', 'questions', 'spaces'];

const token = () => jwt.sign({ id: ME.id, typ: 'access' }, process.env.JWT_SECRET, { expiresIn: '1h' });

let db;
let rpcCalls;
/** What the stubbed search_* functions return, per test. */
let ranked;
/** Set true to make the RPCs look absent, exercising the fallback. */
let rpcMissing;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/search', require('../routes/search.js'));
  a.use('/api/users', require('../routes/users.js'));
  return a;
}

beforeEach(() => {
  rpcCalls = [];
  rpcMissing = false;
  ranked = { people: [], posts: [], questions: [] };

  db = createFakeSupabase({
    users: [{ ...ME }, { ...ALICE }, { ...BOB }],
    posts: [],
    questions: [],
    blocks: []
  });

  // Stand in for migration 007. The real functions rank in SQL; here the test
  // decides the order, which is the thing the route must preserve.
  db.rpc = (name, args) => {
    rpcCalls.push({ name, args });
    if (rpcMissing) {
      return Promise.resolve({
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function public.' + name }
      });
    }
    if (name === 'search_people') return Promise.resolve({ data: ranked.people, error: null });
    if (name === 'search_posts') return Promise.resolve({ data: ranked.posts, error: null });
    if (name === 'search_questions') return Promise.resolve({ data: ranked.questions, error: null });
    return Promise.resolve({ data: null, error: { message: 'no rpc ' + name } });
  };

  __setTestClient(db);
  process.env.NODE_ENV = 'test';
});

const search = (q) =>
  request(app()).get('/api/search').query({ q }).set('Authorization', `Bearer ${token()}`);

describe('response contract', () => {
  it('returns the five keys Search.jsx reads', async () => {
    const res = await search('alice');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(SHAPE_KEYS);
  });

  it('short queries return empty without touching the database', async () => {
    const res = await search('a');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ people: [], posts: [], questions: [], spaces: [], query: 'a' });
    expect(rpcCalls).toHaveLength(0);
  });

  it('matches Spaces by id and label, unranked as before', async () => {
    const res = await search('tech');
    expect(res.body.spaces.some(s => s.id === 'technology')).toBe(true);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app()).get('/api/search').query({ q: 'alice' });
    expect(res.status).toBe(401);
  });
});

describe('ranking', () => {
  it('uses the ranked functions rather than ILIKE', async () => {
    await search('alice');
    expect(rpcCalls.map(c => c.name).sort())
      .toEqual(['search_people', 'search_posts', 'search_questions']);
  });

  it('REGRESSION: people come back in rank order, not database order', async () => {
    // The seam that is easy to get wrong. search_people returns seven columns
    // and shapeUser needs about twenty, so the rows are refetched with .in() —
    // which returns them in whatever order Postgres finds them. Without the
    // reorder the ranking is silently discarded and search looks arbitrary.
    ranked.people = [
      { id: BOB.id, rank: 0.9 },
      { id: ALICE.id, rank: 0.4 }
    ];

    // Two characters minimum — the route short-circuits below that.
    const res = await search('ba');
    expect(res.body.people.map(p => p.name)).toEqual(['Bob Baker', 'Alice Anderson']);
  });

  it('keeps post and question order exactly as ranked', async () => {
    ranked.posts = [
      { id: 'p2', author_id: ALICE.id, content: 'second best', created_at: new Date(0).toISOString(), rank: 0.8 },
      { id: 'p1', author_id: BOB.id, content: 'best match', created_at: new Date().toISOString(), rank: 0.3 }
    ];
    const res = await search('best');
    // p2 first despite being older — rank wins over recency, which is the
    // whole point of the change.
    expect(res.body.posts.map(p => p.id)).toEqual(['p2', 'p1']);
  });

  it('drops a ranked id whose row has since been deleted', async () => {
    ranked.people = [{ id: 'deadbeef-0000-4000-8000-000000000000', rank: 1 }, { id: ALICE.id, rank: 0.5 }];
    const res = await search('alice');
    expect(res.body.people.map(p => p.name)).toEqual(['Alice Anderson']);
  });

  it('passes the viewer to search_people so it can exclude self and blocked', async () => {
    // The function filters is_active, u.id <> p_viewer and the blocks
    // subquery. Sending the wrong viewer would silently disable all three.
    await search('alice');
    const call = rpcCalls.find(c => c.name === 'search_people');
    expect(call.args.p_viewer).toBe(ME.id);
  });

  it('returns empty rather than erroring when nothing matches', async () => {
    const res = await search('zzzzzz');
    expect(res.status).toBe(200);
    expect(res.body.people).toEqual([]);
    expect(res.body.posts).toEqual([]);
    expect(res.body.questions).toEqual([]);
  });
});

describe('fallback when migration 007 is absent', () => {
  it('serves unranked ILIKE results instead of failing', async () => {
    rpcMissing = true;
    const res = await search('alice');

    expect(res.status).toBe(200);
    // Alice is found by the ILIKE path; the shape is unchanged.
    expect(res.body.people.map(p => p.name)).toContain('Alice Anderson');
    expect(Object.keys(res.body).sort()).toEqual(SHAPE_KEYS);
  });

  it('excludes the viewer on the fallback path too', async () => {
    rpcMissing = true;
    const res = await search('me');
    expect(res.body.people.map(p => p.id)).not.toContain(ME.id);
  });
});

describe('hostile input', () => {
  it('survives characters that would break a PostgREST filter', async () => {
    for (const q of ['a,role.eq.admin', 'a.b(c)', "a'or'1'='1", 'a%_\\', 'a)(b']) {
      const res = await search(q);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort())
        .toEqual(SHAPE_KEYS);
    }
  });

  it('sends the query to the RPC as a bound parameter, not a filter string', async () => {
    // On the ranked path the query is an argument, so escaping is not what
    // keeps it safe — but it must still arrive intact enough to match.
    await search('alice anderson');
    const call = rpcCalls.find(c => c.name === 'search_people');
    expect(typeof call.args.p_query).toBe('string');
    expect(call.args.p_query.length).toBeGreaterThan(0);
  });

  it('caps what it asks any function for', async () => {
    // The functions clamp to 50 internally; asking for less keeps the response
    // small and the intent visible at the call site.
    await search('alice');
    for (const c of rpcCalls) {
      expect(c.args.p_limit).toBeLessThanOrEqual(50);
      expect(c.args.p_limit).toBeGreaterThan(0);
    }
  });
});

/* ────────────────────────────────────────────────────────────
 * GET /api/users/search — the people search behind Settings → Find People
 *
 * Same seam as /api/search: search_people returns seven columns, the response
 * needs email and avatar_thumb_url, so the RPC ranks and a second query
 * fetches. The reorder afterwards is the part that is easy to lose.
 * ──────────────────────────────────────────────────────────── */
const findPeople = (q) =>
  request(app()).get('/api/users/search').query({ q }).set('Authorization', `Bearer ${token()}`);

describe('people search', () => {
  it('returns the shape Settings.jsx reads', async () => {
    ranked.people = [{ id: ALICE.id, rank: 0.8 }];
    const res = await findPeople('alice');

    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['users']);
    expect(Object.keys(res.body.users[0]).sort()).toEqual(
      ['_id', 'avatar', 'avatarThumbUrl', 'avatarUrl', 'badges', 'email', 'id', 'name', 'points']
    );
  });

  it('uses the ranked function, not ILIKE', async () => {
    ranked.people = [{ id: ALICE.id, rank: 0.5 }];
    await findPeople('alice');
    expect(rpcCalls.map(c => c.name)).toContain('search_people');
  });

  it('REGRESSION: results come back in rank order, not database order', async () => {
    ranked.people = [
      { id: BOB.id, rank: 0.9 },
      { id: ALICE.id, rank: 0.4 }
    ];
    const res = await findPeople('ba');
    expect(res.body.users.map(u => u.name)).toEqual(['Bob Baker', 'Alice Anderson']);
  });

  it('REGRESSION: passes the viewer so self and blocked are excluded', async () => {
    // search_people filters is_active, u.id <> p_viewer and the blocks
    // subquery. The route this replaced filtered only the viewer's own id, so
    // a blocked account still appeared. Sending the wrong viewer, or none,
    // silently restores that.
    ranked.people = [{ id: ALICE.id, rank: 0.5 }];
    await findPeople('alice');
    const call = rpcCalls.find(c => c.name === 'search_people');
    expect(call.args.p_viewer).toBe(ME.id);
  });

  it('drops a ranked id whose row has since been deleted', async () => {
    ranked.people = [
      { id: 'deadbeef-0000-4000-8000-000000000000', rank: 1 },
      { id: ALICE.id, rank: 0.5 }
    ];
    const res = await findPeople('alice');
    expect(res.body.users.map(u => u.name)).toEqual(['Alice Anderson']);
  });

  it('short queries return empty without calling the RPC', async () => {
    const res = await findPeople('a');
    expect(res.body).toEqual({ users: [] });
    expect(rpcCalls).toHaveLength(0);
  });

  it('returns empty when nothing ranks', async () => {
    ranked.people = [];
    const res = await findPeople('zzzzzz');
    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([]);
  });

  it('falls back to ILIKE when migration 007 is absent', async () => {
    rpcMissing = true;
    const res = await findPeople('alice');
    expect(res.status).toBe(200);
    expect(res.body.users.map(u => u.name)).toContain('Alice Anderson');
    expect(Object.keys(res.body)).toEqual(['users']);
  });

  it('excludes the viewer on the fallback path too', async () => {
    rpcMissing = true;
    const res = await findPeople('me');
    expect(res.body.users.map(u => u.id)).not.toContain(ME.id);
  });

  it('survives hostile input', async () => {
    ranked.people = [];
    for (const q of ['a,role.eq.admin', 'a.b(c)', "a'or'1'='1", 'a%_', 'a)(b']) {
      const res = await findPeople(q);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body)).toEqual(['users']);
    }
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app()).get('/api/users/search').query({ q: 'alice' });
    expect(res.status).toBe(401);
  });
});
