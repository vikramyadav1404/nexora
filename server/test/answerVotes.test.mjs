/**
 * Voting on answers, and the author's points.
 *
 * routes/answers.js had no tests. Four defects lived in one handler, all of
 * them about `users.points`:
 *
 *   1. `if (type === 'up') ... else { downvote }` with no allowlist, so an
 *      empty body cast a downvote.
 *   2. The downvote deducts with a floor at zero and the undo restored
 *      unconditionally, so undoing a downvote that cost nothing created a
 *      point out of nothing.
 *   3. Switching down -> up was an empty branch: the deducted point was never
 *      returned and the upvote counter was never incremented.
 *   4. The author's row was read once, mutated across several awaits, and
 *      written back as an absolute -- reverting any concurrent change.
 *
 * The first three are logic; the fourth needed the arithmetic to move into the
 * database (migration 016).
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

const AUTHOR = '00000000-0000-4000-8000-00000000000a';
const VOTER = '00000000-0000-4000-8000-00000000000b';
const VOTER2 = '00000000-0000-4000-8000-00000000000c';
const ANSWER = 'answer-1';

let db;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/answers', require('../routes/answers.js'));
  return a;
}

const token = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });

const vote = (type, as = VOTER) =>
  request(app()).post(`/api/answers/${ANSWER}/vote`)
    .set('Authorization', `Bearer ${token(as)}`)
    .send(type === undefined ? {} : { type });

const author = () => db._tables.users.find(u => u.id === AUTHOR);
const voteRow = (as = VOTER) =>
  db._tables.answer_votes.find(v => v.answer_id === ANSWER && v.user_id === as);

function setup({ points = 10, votes = [] } = {}) {
  db = createFakeSupabase({
    users: [
      { id: AUTHOR, name: 'Author', email: 'a@n.test', is_active: true, points, total_answers: 3, total_upvotes_received: 0, badges: [] },
      { id: VOTER, name: 'Voter', email: 'v@n.test', is_active: true, points: 50 },
      { id: VOTER2, name: 'Voter2', email: 'v2@n.test', is_active: true, points: 50 }
    ],
    answers: [{ id: ANSWER, author_id: AUTHOR, body: 'an answer', bonus_points_awarded: false }],
    answer_votes: votes
  });
  __setTestClient(db);
}

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  setup();
});

describe('the vote type is validated', () => {
  it('REGRESSION: an empty body does not cast a downvote', async () => {
    const res = await vote(undefined);

    expect(res.status).toBe(400);
    expect(author().points).toBe(10);
    expect(db._tables.answer_votes).toHaveLength(0);
  });

  it('REGRESSION: an unrecognised type is refused rather than treated as down', async () => {
    for (const bad of ['upvote', 'UP', null, 1, '']) {
      setup();
      const res = await vote(bad);
      expect(res.status).toBe(400);
      expect(author().points).toBe(10);
    }
  });

  it('accepts the two real values', async () => {
    expect((await vote('up')).status).toBe(200);
    setup();
    expect((await vote('down')).status).toBe(200);
  });
});

describe('points are never created from nothing', () => {
  it('REGRESSION: undoing a downvote that cost nothing credits nothing', async () => {
    // An author at zero is already at the floor, so the downvote deducts
    // nothing -- and the undo used to credit a point regardless.
    setup({ points: 0 });

    await vote('down');
    expect(author().points).toBe(0);
    expect(voteRow().points_applied).toBe(false);

    await vote('down'); // tapping down again removes it

    expect(author().points).toBe(0);
  });

  it('REGRESSION: two voters downvoting and undoing leave an author at zero', async () => {
    setup({ points: 0 });

    await vote('down', VOTER);
    await vote('down', VOTER2);
    await vote('down', VOTER);   // undo
    await vote('down', VOTER2);  // undo

    // Before the fix this was 2 -- one minted point per voter.
    expect(author().points).toBe(0);
  });

  it('a downvote that did deduct is restored on undo', async () => {
    setup({ points: 10 });

    await vote('down');
    expect(author().points).toBe(9);
    expect(voteRow().points_applied).toBe(true);

    await vote('down');

    expect(author().points).toBe(10);
  });
});

describe('switching down to up', () => {
  it('REGRESSION: returns the deducted point and counts the upvote', async () => {
    setup({ points: 10 });

    await vote('down');
    expect(author().points).toBe(9);

    await vote('up');

    // The branch was empty: the point stayed lost and the upvote uncounted.
    expect(author().points).toBe(10);
    expect(author().total_upvotes_received).toBe(1);
  });

  it('down then up matches down then remove then up', async () => {
    setup({ points: 10 });
    await vote('down');
    await vote('up');
    const direct = { points: author().points, upvotes: author().total_upvotes_received };

    setup({ points: 10 });
    await vote('down');
    await vote('down'); // remove
    await vote('up');

    expect({ points: author().points, upvotes: author().total_upvotes_received }).toEqual(direct);
  });

  it('switching down to up on a zero-point author credits nothing', async () => {
    setup({ points: 0 });
    await vote('down');

    await vote('up');

    expect(author().points).toBe(0);
    expect(author().total_upvotes_received).toBe(1);
  });
});

describe('ordinary upvoting', () => {
  it('counts an upvote and does not touch points', async () => {
    setup({ points: 10 });

    const res = await vote('up');

    expect(res.status).toBe(200);
    expect(res.body.upvotes).toBe(1);
    expect(author().points).toBe(10);
    expect(author().total_upvotes_received).toBe(1);
  });

  it('tapping up again removes the upvote', async () => {
    await vote('up');
    await vote('up');

    expect(author().total_upvotes_received).toBe(0);
    expect(db._tables.answer_votes).toHaveLength(0);
  });

  it('the author cannot vote on their own answer', async () => {
    const res = await vote('up', AUTHOR);
    expect(res.status).toBe(400);
  });
});

describe('concurrent writes do not revert each other', () => {
  const { applyVotePoints } = require('../utils/votePoints.js');

  it('REGRESSION: a concurrent award survives a vote landing at the same time', async () => {
    setup({ points: 10 });

    /*
     * Two callers, both holding the balance they read before either wrote.
     * The old handler wrote an absolute, so whichever landed second reverted
     * the other. Deltas commute.
     */
    await applyVotePoints(db, AUTHOR, 5, 0);   // an answer award
    await applyVotePoints(db, AUTHOR, -1, 0);  // a downvote

    expect(author().points).toBe(14);
  });

  it('neither counter can be driven below zero', async () => {
    setup({ points: 0 });

    await applyVotePoints(db, AUTHOR, -5, -5);

    expect(author().points).toBe(0);
    expect(author().total_upvotes_received).toBe(0);
  });

  it('badges from the RPC match computeBadges', () => {
    /*
     * Migration 016 recomputes badges in SQL, duplicating computeBadges. The
     * duplication is the price of doing the arithmetic in one statement; this
     * is the test that keeps the two honest.
     */
    const { computeBadges } = require('../db/helpers.js');
    for (const [points, answers] of [[0, 0], [50, 0], [200, 12], [500, 60], [49, 9]]) {
      const expected = computeBadges(points, answers);
      const actual = [];
      if (points >= 50) actual.push('bronze');
      if (points >= 200) actual.push('silver');
      if (points >= 500) actual.push('gold');
      if (answers >= 10) actual.push('contributor');
      if (answers >= 50) actual.push('expert');
      expect(actual).toEqual(expected);
    }
  });
});

/*
 * Migration 021: posting and deleting an answer move the author's points in the
 * same transaction as the answer row, against the current balance.
 *
 * Both routes used to write `points = req.userRow.points ± 5` -- the copy
 * protect loaded when the request started -- so anything that changed the
 * balance in between was reverted. To reproduce that, these tests change the
 * balance after protect has loaded the user and before the points move, by
 * wrapping the RPC: exactly the window the old code wrote across.
 */
describe('posting and deleting an answer do not revert concurrent points', () => {
  const QUESTION = 'question-1';

  function setupQA({ points = 10 } = {}) {
    setup({ points });
    db._tables.questions = [{ id: QUESTION, author_id: VOTER, title: 'q', accepted_answer_id: null }];
  }

  /** Run `sideEffect` just before the named RPC, as a concurrent request would. */
  function beforeRpc(name, sideEffect) {
    const original = db.rpc.bind(db);
    db.rpc = async (fn, args) => {
      if (fn === name) await sideEffect();
      return original(fn, args);
    };
  }

  const post = (body = 'my answer') =>
    request(app()).post(`/api/answers/${QUESTION}`)
      .set('Authorization', `Bearer ${token(AUTHOR)}`)
      .send({ body });

  const del = (id, as = AUTHOR) =>
    request(app()).delete(`/api/answers/${id}`)
      .set('Authorization', `Bearer ${token(as)}`);

  it('REGRESSION: a downvote landing mid-request survives posting an answer', async () => {
    setupQA({ points: 10 });
    // A downvote on an older answer lands after protect read 10 points.
    beforeRpc('create_answer', async () => { author().points = 9; });

    const res = await post();

    expect(res.status).toBe(201);
    expect(author().points).toBe(14);       // 9 + 5, not the stale 10 + 5
    expect(author().total_answers).toBe(4);
    expect(db._tables.answers.filter(a => a.author_id === AUTHOR)).toHaveLength(2);
  });

  it('REGRESSION: an award landing mid-request survives deleting an answer', async () => {
    setupQA({ points: 20 });
    db._tables.answers.push({ id: 'answer-2', author_id: AUTHOR, question_id: QUESTION, points_awarded: true });
    beforeRpc('delete_answer', async () => { author().points = 25; }); // +5 elsewhere

    const res = await del('answer-2');

    expect(res.status).toBe(200);
    expect(author().points).toBe(20);       // 25 - 5, not the stale 20 - 5
    expect(db._tables.answers.find(a => a.id === 'answer-2')).toBeUndefined();
  });

  it('only the author can delete, and nothing moves when refused', async () => {
    setupQA({ points: 20 });
    const res = await del(ANSWER, VOTER);
    expect(res.status).toBe(403);
    expect(author().points).toBe(20);
    expect(db._tables.answers.find(a => a.id === ANSWER)).toBeDefined();
  });

  it('a missing function is a 503 that writes nothing (no racy fallback)', async () => {
    setupQA({ points: 10 });
    delete db._rpc.create_answer;

    const res = await post();

    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/021_answer_points_atomic\.sql/);
    expect(author().points).toBe(10);
    expect(db._tables.answers.filter(a => a.author_id === AUTHOR)).toHaveLength(1);
  });

  it('a missing cast_answer_vote is a 503 that records no vote', async () => {
    setupQA({ points: 10 });
    delete db._rpc.cast_answer_vote;

    const res = await vote('up');

    expect(res.status).toBe(503);
    expect(voteRow()).toBeUndefined();
    expect(author().total_upvotes_received).toBe(0);
  });
});
