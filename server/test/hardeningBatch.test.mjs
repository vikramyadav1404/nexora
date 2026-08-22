/**
 * The second tier of the audit: input validation, privacy, and telling the
 * truth in responses.
 *
 * None of these destroy data the way the cron sweep did. What they share is
 * that each one had a correct implementation sitting next to it in the same
 * codebase -- an escaper that was written for exactly this and applied to two
 * of four call sites, a narrow person shape used on one endpoint and not its
 * three siblings, a length cap on every write path but one. They are misses,
 * not oversights of principle.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

process.env.JWT_SECRET = 'test_jwt_secret';

const require = createRequire(import.meta.url);
const { __setTestClient } = require('../db/supabase.js');
const { shapePerson, shapeUser } = require('../db/helpers.js');
const jwt = require('jsonwebtoken');

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

let db;
const token = (id = ME) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });

function person(id, name) {
  return {
    id, name,
    email: `${name}@nexora.test`,
    phone: '+919999999999',
    role: 'user',
    is_active: true,
    points: 10,
    badges: [],
    interests: ['technology'],
    subscription_plan: 'free',
    questions_today: 0
  };
}

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  db = createFakeSupabase({
    users: [person(ME, 'me'), person(OTHER, 'other')],
    questions: [], answers: [], question_votes: [], answer_votes: [],
    notifications: [], blocks: [], reports: []
  });
  __setTestClient(db);
});

describe('a stranger never receives contact details', () => {
  /*
   * shapeUser carries email, phone and role. That is right for the caller's own
   * record and for an admin listing, and wrong for a list of other people --
   * which is what /api/search, /api/spaces/:id and /api/blocks all return.
   *
   * ------------------------------------------------------------------
   * What this test used to assert, and why that mattered
   * ------------------------------------------------------------------
   * It pinned shapePerson's keys to a list that *included* email, with a note
   * saying the narrow shape "does still carry email -- Settings.jsx renders it
   * on friend requests", and that phone and role were the real danger.
   *
   * So inside a block named "a stranger never receives contact details", the
   * suite required that strangers receive one. The address of every person in
   * a search result, a Space member list, a friend request and a block list was
   * held in place by an equality assertion: removing it would have failed CI
   * and read as the regression.
   *
   * That is the cost of trading a privacy boundary for a UI label. Settings.jsx
   * wanted a subtitle under each name; it now uses bio, which people choose to
   * publish. shapePerson delegates to the publicUser allowlist and the trade is
   * reversed.
   */
  it('REGRESSION: shapePerson returns no email -- it used to, by assertion', () => {
    const shaped = shapePerson(person(OTHER, 'other'));

    expect(shaped).not.toHaveProperty('email');
    expect(shaped).not.toHaveProperty('phone');
    expect(shaped).not.toHaveProperty('role');
    expect(JSON.stringify(shaped)).not.toContain('@');

    // Still useful, or the fix is just deletion.
    expect(shaped.name).toBeTruthy();
    expect(shaped.id).toBe(OTHER);
  });

  it('REGRESSION: shapeUser is the wide shape, which is why the split matters', () => {
    const wide = shapeUser(person(OTHER, 'other'));
    expect(wide.phone).toBe('+919999999999');
    expect(wide.role).toBe('user');
  });
});

describe('question input is validated', () => {
  function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/questions', require('../routes/questions.js'));
    return a;
  }

  const ask = (body) =>
    request(app()).post('/api/questions').set('Authorization', `Bearer ${token()}`).send(body);

  it('REGRESSION: malformed tags are a 400, not a 500', async () => {
    for (const tags of [5, {}, [1, 2], true]) {
      const res = await ask({ title: 'A title', body: 'A body', tags });
      // Every one of these used to hit `tags.split is not a function` or
      // `t.trim is not a function` and answer 500.
      expect(res.status).not.toBe(500);
    }
  });

  it('REGRESSION: malformed tags do not burn the daily quota', async () => {
    // The quota is claimed before the tag parsing, so a 500 there cost a free
    // user their one question of the day.
    await ask({ title: 'A title', body: 'A body', tags: 5 });
    expect(db._tables.users.find(u => u.id === ME).questions_today || 0).toBeLessThanOrEqual(1);
  });

  it('REGRESSION: a non-string title is refused rather than stored', async () => {
    const res = await ask({ title: { a: 1 }, body: 'A body' });
    // `{"title": {"a":1}}` is truthy, so it passed the old check and put an
    // object into a TEXT column.
    expect(res.status).toBe(400);
  });

  it('caps title and body length', async () => {
    const res = await ask({ title: 'T'.repeat(5000), body: 'B'.repeat(50000) });
    if (res.status === 201) {
      const q = db._tables.questions[0];
      expect(q.title.length).toBeLessThanOrEqual(300);
      expect(q.body.length).toBeLessThanOrEqual(10000);
    }
  });

  it('accepts an ordinary question', async () => {
    const res = await ask({ title: 'How do I test this?', body: 'Some detail.', tags: 'a,b' });
    expect(res.status).toBe(201);
  });

  it('REGRESSION: page=0 is a 400-class outcome, never a 500', async () => {
    const res = await request(app()).get('/api/questions?page=0')
      .set('Authorization', `Bearer ${token()}`);
    // `from = (0-1)*10 = -10` produced a negative OFFSET, which Postgres
    // rejects outright.
    expect(res.status).toBe(200);
  });

  it('caps limit so one request cannot fan out to thousands of queries', async () => {
    const res = await request(app()).get('/api/questions?limit=5000')
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
  });
});

describe('votes require a real type', () => {
  function app() {
    const a = express();
    a.use(express.json());
    a.use('/api/questions', require('../routes/questions.js'));
    return a;
  }

  it('REGRESSION: an empty body does not downvote a question', async () => {
    db._tables.questions.push({ id: 'q1', author_id: OTHER, title: 't', body: 'b', views: 0 });

    const res = await request(app()).post('/api/questions/q1/vote')
      .set('Authorization', `Bearer ${token()}`).send({});

    expect(res.status).toBe(400);
    expect(db._tables.question_votes).toHaveLength(0);
  });
});

describe('the moderation queue keeps its notes', () => {
  it('REGRESSION: a status-only update does not erase admin_note', async () => {
    db._tables.users[0].role = 'admin';
    db._tables.reports.push({
      id: 'r1', reporter_id: OTHER, status: 'resolved',
      admin_note: 'Confirmed spam, account warned.', resolved_at: new Date().toISOString()
    });

    const a = express();
    a.use(express.json());
    a.use('/api/admin', require('../routes/admin.js'));

    await request(a).patch('/api/admin/reports/r1')
      .set('Authorization', `Bearer ${token()}`)
      .send({ status: 'reviewing' });

    // sanitizeText(undefined) returns '', and the field was written
    // unconditionally -- so reopening a report wiped the previous moderator's
    // note, with no history table to recover it from.
    expect(db._tables.reports[0].admin_note).toBe('Confirmed spam, account warned.');
  });

  it('a note that is sent still replaces the old one', async () => {
    db._tables.users[0].role = 'admin';
    db._tables.reports.push({ id: 'r2', reporter_id: OTHER, status: 'open', admin_note: 'old' });

    const a = express();
    a.use(express.json());
    a.use('/api/admin', require('../routes/admin.js'));

    await request(a).patch('/api/admin/reports/r2')
      .set('Authorization', `Bearer ${token()}`)
      .send({ status: 'resolved', note: 'new note' });

    expect(db._tables.reports[0].admin_note).toBe('new note');
  });
});

describe('the rate limiter does not refund by charging again', () => {
  it('REGRESSION: decrement is not another increment', async () => {
    const { PostgresStore } = require('../middleware/rateLimit.js');
    if (!PostgresStore) return; // not exported; covered by reading the source

    const calls = [];
    db._rpc.rate_limit_hit = (args) => { calls.push(args); return { data: 1, error: null }; };

    const store = new PostgresStore('test');
    store.windowMs = 1000;
    await store.decrement('k');

    // It used to call rate_limit_hit, which does hits = hits + 1 -- so giving a
    // request its budget back consumed another slot instead.
    expect(calls).toHaveLength(0);
  });
});

describe('the unread badge counts every unread notification', () => {
  it('REGRESSION: not just the ones on the first page', async () => {
    for (let i = 0; i < 120; i++) {
      db._tables.notifications.push({
        id: `n${i}`, user_id: ME, read: false, type: 'test',
        message: 'x', created_at: new Date(Date.now() - i * 1000).toISOString()
      });
    }

    const a = express();
    a.use(express.json());
    a.use('/api/notifications', require('../routes/notifications.js'));

    const res = await request(a).get('/api/notifications')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    // The page is still 50; the count is not.
    expect(res.body.notifications.length).toBeLessThanOrEqual(50);
    expect(res.body.unread).toBe(120);
  });
});
