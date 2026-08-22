/**
 * Contact details must not reach anyone but the account holder.
 *
 * Every user serialiser in this codebase was a denylist, and one of them --
 * shapePerson, the one three call sites documented as "the safe shape" --
 * stripped the phone number and kept the email. So six routes handed a
 * logged-in stranger somebody's address, and the profile route added their
 * phone number, role, quota counters and Razorpay subscription id.
 *
 * ------------------------------------------------------------------
 * How these are written, and why
 * ------------------------------------------------------------------
 * Table-driven over every leaking route, because that was the actual failure:
 * the problem was found once, fixed in one place, and left in five others. A
 * per-route test written by hand would have had the same gap as the code.
 *
 * Assertions run against the whole serialised body, not against named keys. A
 * key-based check passes if the address moves to `contactEmail`, or nests one
 * level deeper, or arrives inside an array -- all of which are ways this has
 * already gone wrong once.
 *
 * The fake's select() ignores its field list and returns whole rows, which is
 * exactly what these need: the row reaching the serialiser carries an email, so
 * a passing test proves the serialiser removed it rather than proving the
 * query never asked for it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

const require = createRequire(import.meta.url);
const { __setTestClient } = require('../db/supabase.js');
const { publicUser, ownerUser, serializeUser } = require('../db/serialize.js');
const jwt = require('jsonwebtoken');

const SECRET = 'a-test-secret-long-enough-to-pass-the-floor';
const VIEWER = '00000000-0000-4000-8000-000000000001';
const SUBJECT = '00000000-0000-4000-8000-000000000002';

/*
 * A third account, unblocked.
 *
 * The search routes filter out anyone the viewer has blocked, and the viewer
 * blocks SUBJECT so the /api/blocks route has something to return. Searching
 * for SUBJECT therefore came back empty, and "the response contains no email"
 * was true because the response contained nothing at all -- two of these tests
 * passed without exercising a line of the code they name. STRANGER is who the
 * search tests look for, and every route below now asserts the person it
 * expects is actually present.
 */
const STRANGER = '00000000-0000-4000-8000-000000000003';

const SUBJECT_EMAIL = 'subject-private@nexora.test';
const SUBJECT_PHONE = '+91-99999-88888';
const VIEWER_EMAIL = 'viewer-private@nexora.test';
const VIEWER_PHONE = '+91-77777-66666';

let db;
const saved = {};

function user(id, { email, phone, name }) {
  return {
    id,
    name,
    email,
    phone,
    bio: 'A bio that is genuinely public',
    avatar: '',
    is_active: true,
    email_verified: true,
    role: 'user',
    points: 100,
    badges: ['bronze'],
    total_answers: 5,
    interests: ['technology'],
    subscription_plan: 'pro',
    razorpay_subscription_id: 'sub_INTERNAL123',
    questions_today: 3,
    posts_today: 2,
    created_at: '2026-01-01T00:00:00Z'
  };
}

const token = (id) => jwt.sign({ id, typ: 'access' }, SECRET, { expiresIn: '1h' });

function app(mountPath, routerPath) {
  const a = express();
  a.use(express.json());
  a.use(mountPath, require(routerPath));
  return a;
}

beforeEach(() => {
  saved.JWT_SECRET = process.env.JWT_SECRET;
  saved.NODE_ENV = process.env.NODE_ENV;
  process.env.JWT_SECRET = SECRET;
  process.env.NODE_ENV = 'test';

  db = createFakeSupabase({
    users: [
      user(VIEWER, { email: VIEWER_EMAIL, phone: VIEWER_PHONE, name: 'Viewer' }),
      user(SUBJECT, { email: SUBJECT_EMAIL, phone: SUBJECT_PHONE, name: 'Subject' }),
      user(STRANGER, { email: 'stranger-private@nexora.test', phone: '+91-55555-44444', name: 'Stranger' })
    ],
    blocks: [{ blocker_id: VIEWER, blocked_id: SUBJECT }],
    friend_requests: [{ from_user_id: SUBJECT, to_user_id: VIEWER, status: 'pending' }],
    friendships: [],
    posts: [],
    questions: [],
    follows: []
  });
  __setTestClient(db);
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/**
 * Every route that returns another user, with how to call it.
 *
 * Adding a route here is how a new user-returning endpoint gets covered; that
 * is the point of the table. If one of these ever needs to be removed, the
 * reason belongs in the commit.
 */
const ROUTES = [
  {
    name: 'GET /api/users/:id  (the profile page)',
    mustContain: 'Subject',
    call: () => request(app('/api/users', '../routes/users.js'))
      .get(`/api/users/${SUBJECT}`)
      .set('Authorization', `Bearer ${token(VIEWER)}`)
  },
  {
    name: 'GET /api/search  (people results)',
    mustContain: 'Stranger',
    call: () => request(app('/api/search', '../routes/search.js'))
      .get('/api/search?q=Stranger')
      .set('Authorization', `Bearer ${token(VIEWER)}`)
  },
  {
    name: 'GET /api/users/search',
    mustContain: 'Stranger',
    call: () => request(app('/api/users', '../routes/users.js'))
      .get('/api/users/search?q=Stranger')
      .set('Authorization', `Bearer ${token(VIEWER)}`)
  },
  {
    name: 'GET /api/users/me/requests  (incoming friend requests)',
    mustContain: 'Subject',
    call: () => request(app('/api/users', '../routes/users.js'))
      .get('/api/users/me/requests')
      .set('Authorization', `Bearer ${token(VIEWER)}`)
  },
  {
    name: 'GET /api/blocks',
    mustContain: 'Subject',
    call: () => request(app('/api', '../routes/safety.js'))
      .get('/api/blocks')
      .set('Authorization', `Bearer ${token(VIEWER)}`)
  },
  {
    name: 'GET /api/spaces/:id  (member list)',
    mustContain: 'Stranger',
    call: () => request(app('/api/spaces', '../routes/spaces.js'))
      .get('/api/spaces/technology')
      .set('Authorization', `Bearer ${token(VIEWER)}`)
  }
];

describe('no route hands another user their contact details', () => {
  for (const route of ROUTES) {
    it(`REGRESSION: ${route.name} contains no email and no phone`, async () => {
      const res = await route.call();

      // A 4xx would pass the leak assertions vacuously. Fail loudly instead of
      // silently proving nothing.
      expect(res.status, `${route.name} did not return 200`).toBe(200);

      const body = JSON.stringify(res.body);

      /*
       * The person must actually be in the payload. Two of these tests passed
       * against an empty array before this line existed -- "contains no email"
       * is trivially true of `{"people":[]}`, and a serialiser that returned
       * nothing at all would have looked like a fix.
       */
      expect(body, `${route.name} returned no user to check`).toContain(route.mustContain);

      expect(body).not.toContain(SUBJECT_EMAIL);
      expect(body).not.toContain(SUBJECT_PHONE);
      // Not just this fixture's address -- any address at all.
      expect(body).not.toMatch(/@nexora\.test/);
    });
  }
});

describe('the positive control', () => {
  /*
   * Without these, a serialiser that returned {} would pass every test above.
   * "Leaks nothing" and "works" have to be asserted separately or the suite
   * only measures one of them.
   */
  it('the owner still gets their own email and phone from /api/users/:id', async () => {
    const res = await request(app('/api/users', '../routes/users.js'))
      .get(`/api/users/${VIEWER}`)
      .set('Authorization', `Bearer ${token(VIEWER)}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(VIEWER_EMAIL);
    expect(res.body.user.phone).toBe(VIEWER_PHONE);
  });

  it('the public routes still return the people they are for', async () => {
    // The subject must actually be in these payloads -- otherwise "no email"
    // is true because the response is empty.
    const res = await request(app('/api', '../routes/safety.js'))
      .get('/api/blocks')
      .set('Authorization', `Bearer ${token(VIEWER)}`);

    expect(res.body.blocks).toHaveLength(1);
    expect(res.body.blocks[0].name).toBe('Subject');
    expect(res.body.blocks[0].points).toBe(100);
  });
});

describe('the serialiser itself', () => {
  const row = () => user(SUBJECT, { email: SUBJECT_EMAIL, phone: SUBJECT_PHONE, name: 'Subject' });

  it('REGRESSION: a column added by a later migration is private by default', () => {
    /*
     * The property the whole module exists for, and the one that protects the
     * next person rather than this bug.
     *
     * shapeUser destructured four secrets out and spread the rest, so every
     * column added after it was written arrived in the API public. An allowlist
     * inverts that: unknown columns are absent until somebody names them.
     */
    const withNewColumn = { ...row(), secret_new_column: 'ADDED-BY-MIGRATION-019' };

    expect(JSON.stringify(publicUser(withNewColumn))).not.toContain('ADDED-BY-MIGRATION-019');
    expect(JSON.stringify(ownerUser(withNewColumn))).not.toContain('ADDED-BY-MIGRATION-019');
  });

  it('REGRESSION: withholds internal state, not just contact details', () => {
    const body = JSON.stringify(publicUser(row()));

    expect(body).not.toContain('sub_INTERNAL123');   // Razorpay subscription id
    expect(body).not.toContain('questionsToday');    // quota counters
    expect(body).not.toContain('postsToday');
    expect(body).not.toContain('emailVerified');     // verification state
    expect(body).not.toContain('"role"');            // privilege
    expect(body).not.toContain('isActive');          // moderation state
  });

  it('still carries what a profile needs to render', () => {
    const u = publicUser(row());

    expect(u.name).toBe('Subject');
    expect(u.bio).toBe('A bio that is genuinely public');
    expect(u.points).toBe(100);
    expect(u.badges).toEqual(['bronze']);
    expect(u.subscription.plan).toBe('pro');
    expect(u.createdAt).toBe('2026-01-01T00:00:00Z');
  });

  it('REGRESSION: never returns the owner shape for someone else\'s row', () => {
    // The viewer id is compared against the row id inside the serialiser, so
    // there is no argument a route can get wrong to unlock the owner shape.
    const body = JSON.stringify(serializeUser(row(), VIEWER));
    expect(body).not.toContain(SUBJECT_EMAIL);
    expect(body).not.toContain(SUBJECT_PHONE);
  });

  it('returns the owner shape when the viewer is the subject', () => {
    const u = serializeUser(row(), SUBJECT);
    expect(u.email).toBe(SUBJECT_EMAIL);
    expect(u.phone).toBe(SUBJECT_PHONE);
  });

  it('REGRESSION: an absent viewer id does not unlock the owner shape', () => {
    // undefined === undefined would be true if the guard compared loosely, and
    // an unauthenticated path would then get everything.
    const anonymous = { ...row(), id: undefined };
    expect(JSON.stringify(serializeUser(anonymous, undefined))).not.toContain(SUBJECT_EMAIL);
  });
});

describe('the friend list is a social graph, not a stat', () => {
  const row = () => user(SUBJECT, { email: SUBJECT_EMAIL, phone: SUBJECT_PHONE, name: 'Subject' });
  const FRIEND_A = '00000000-0000-4000-8000-00000000000a';

  it('REGRESSION: a stranger gets a count, never the members', () => {
    const u = serializeUser(row(), VIEWER, { friendIds: [FRIEND_A, VIEWER] });

    expect(u.friendCount).toBe(2);
    expect(u.friends).toBeUndefined();
    expect(JSON.stringify(u)).not.toContain(FRIEND_A);
  });

  it('answers "are we friends" without disclosing who else is', () => {
    // The one thing the profile page actually needed the array for.
    expect(serializeUser(row(), VIEWER, { friendIds: [VIEWER] }).isFriend).toBe(true);
    expect(serializeUser(row(), VIEWER, { friendIds: [FRIEND_A] }).isFriend).toBe(false);
  });

  it('the owner still gets the full list', () => {
    const u = serializeUser(row(), SUBJECT, { friends: [{ id: FRIEND_A, name: 'Friend' }] });
    expect(u.friends).toHaveLength(1);
  });
});
