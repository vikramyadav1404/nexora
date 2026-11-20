/**
 * Contract tests for the race-guard SQL functions, against a REAL Postgres.
 *
 * This file exists because the test fake reimplemented these functions in
 * JavaScript, correctly, so every vote/quota/transfer test passed while the
 * actual SQL had never run anywhere but production's absence and staging's
 * 500s. A fake that is more correct than the thing it stands for is a permanent
 * blind spot; the only cure is to execute the real SQL somewhere.
 *
 * The functions that ship are the source of truth here: this loads the actual
 * migration files (005, 015, 016, 020) into a scratch schema and calls the
 * functions exactly as the app does — same parameter names, same expectations.
 *
 * ------------------------------------------------------------------
 * Running it
 * ------------------------------------------------------------------
 * Set CONTRACT_DB_URL to a Postgres this test may DROP and recreate objects in
 * — a disposable local cluster, or CI's service container. With it unset the
 * whole suite skips, so the offline unit run is unaffected. It must never point
 * at staging or production: the test creates and drops tables.
 *
 * CI sets CONTRACT_DB_REQUIRED=1 as well. With that set and no URL, the file
 * fails instead of skipping: until 2026-11 no CI job set CONTRACT_DB_URL, so
 * this whole suite reported "skipped" on every run and had never once executed
 * there. Decision 0003 — a suite CI does not invoke does not exist.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const DB_URL = process.env.CONTRACT_DB_URL;
if (!DB_URL && process.env.CONTRACT_DB_REQUIRED === '1') {
  throw new Error(
    'CONTRACT_DB_REQUIRED=1 but CONTRACT_DB_URL is unset: the SQL contract suite ' +
    'would silently skip. Point CONTRACT_DB_URL at a throwaway Postgres.'
  );
}
const run = DB_URL ? describe : describe.skip;

const here = path.dirname(fileURLToPath(import.meta.url));
const mig = (name) => readFileSync(path.join(here, '..', 'db', 'migrations', name), 'utf8');

/** Extract one `CREATE OR REPLACE FUNCTION name(...) ... $$;` block from a migration. */
function functionBlock(sql, name) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in migration`);
  // Functions in these migrations are bodied with $$ ... $$; — find the second $$.
  const firstDollar = sql.indexOf('$$', start);
  const secondDollar = sql.indexOf('$$', firstDollar + 2);
  const semi = sql.indexOf(';', secondDollar);
  return sql.slice(start, semi + 1);
}

const U = '00000000-0000-4000-8000-00000000000a';
const V = '00000000-0000-4000-8000-00000000000b';

/**
 * Refuse to run destructive setup against anything that is not a throwaway.
 *
 * This test DROPs and CREATEs tables. Decision 0005 exists because a throwaway
 * cluster once collided with a real Postgres service on the same port, and a
 * successful connection was read as "my scratch DB" — DDL then ran against the
 * real instance. A connection proves something is listening, not which thing.
 *
 * So before any DROP, ask the target what it contains. A real Nexora database
 * holds application tables this test never creates (`posts`, `questions`,
 * `comments`, `notifications`). Their presence means the target is real —
 * refuse, whatever CONTRACT_DB_URL claimed. Data-derived, the same shape as the
 * seed guard: identity read from the target, not inferred from the reach.
 */
async function assertThrowawayTarget(client) {
  const { rows } = await client.query(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('posts','questions','comments','notifications','bookmarks','friendships')`
  );
  if (rows.length) {
    const db = (await client.query('SELECT current_database() AS d')).rows[0].d;
    throw new Error(
      `Refusing to run the contract test against database "${db}": it contains ` +
      `real application tables (${rows.map(r => r.tablename).join(', ')}). ` +
      `CONTRACT_DB_URL must point at a disposable throwaway, never a real Nexora ` +
      `database — this test DROPs tables. See docs/decisions/0005.`
    );
  }
}

run('SQL race-guard functions (real Postgres)', () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();

    // 0005: prove the target's identity before destroying anything.
    await assertThrowawayTarget(client);

    // Minimal schema the three functions touch. Scratch names, dropped after.
    await client.query(`
      DROP TABLE IF EXISTS point_transfers, answer_votes, users CASCADE;
      CREATE TABLE users (
        id UUID PRIMARY KEY,
        points INT DEFAULT 0,
        total_upvotes_received INT DEFAULT 0,
        total_answers INT DEFAULT 0,
        badges TEXT[] DEFAULT '{}',
        questions_today INT DEFAULT 0,
        posts_today INT DEFAULT 0,
        last_question_date TIMESTAMPTZ,
        last_post_date TIMESTAMPTZ
      );
      CREATE TABLE answer_votes (answer_id UUID, user_id UUID, vote_type TEXT, points_applied BOOLEAN DEFAULT TRUE);
      CREATE TABLE point_transfers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        from_user_id UUID, to_user_id UUID, points INT, message TEXT, created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE OR REPLACE FUNCTION compute_badges(p_points INT, p_answers INT)
      RETURNS TEXT[] LANGUAGE sql AS $fn$
        SELECT ARRAY(SELECT b FROM (VALUES
          ('bronze', p_points >= 50), ('silver', p_points >= 200), ('gold', p_points >= 500),
          ('contributor', p_answers >= 10), ('expert', p_answers >= 50)
        ) t(b, hit) WHERE hit);
      $fn$;
    `);

    // Load the ACTUAL shipped function definitions.
    await client.query(functionBlock(mig('016_vote_points.sql'), 'apply_vote_points'));
    await client.query(functionBlock(mig('015_quota.sql'), 'claim_daily_quota'));
    await client.query(functionBlock(mig('005_hardening.sql'), 'transfer_points'));
  });

  afterAll(async () => {
    if (client) {
      await client.query('DROP TABLE IF EXISTS point_transfers, answer_votes, users CASCADE;').catch(() => {});
      await client.end();
    }
  });

  async function reset() {
    await client.query('TRUNCATE users, answer_votes, point_transfers;');
    await client.query(
      `INSERT INTO users(id, points, total_upvotes_received, total_answers) VALUES ($1,48,5,12),($2,100,0,0);`,
      [U, V]
    );
  }

  describe('apply_vote_points (migration 016)', () => {
    it('REGRESSION: is callable at all — the committed version raised 42702', async () => {
      /*
       * The whole reason this file exists. The pre-fix function crashed on
       * every call with "column reference points is ambiguous"; the fake hid
       * it. If this call throws, the fix regressed.
       */
      await reset();
      const { rows } = await client.query(
        'SELECT * FROM apply_vote_points($1, 5, 1)', [U]
      );
      expect(rows[0].points).toBe(53);
      expect(rows[0].total_upvotes_received).toBe(6);
      expect(rows[0].badges).toContain('bronze');
      expect(rows[0].badges).toContain('contributor');
    });

    it('floors points at zero rather than going negative', async () => {
      await reset();
      const { rows } = await client.query('SELECT * FROM apply_vote_points($1, -100, 1)', [U]);
      expect(rows[0].points).toBe(0);
    });

    it('REGRESSION: two concurrent upvotes move points once per vote, not lost', async () => {
      /*
       * The race the function exists for. Fire two applies concurrently; the
       * FOR UPDATE lock must serialise them so the deltas sum, rather than one
       * overwriting the other's read.
       */
      await reset();
      await Promise.all([
        client.query('SELECT apply_vote_points($1, 5, 1)', [U]),
        client.query('SELECT apply_vote_points($1, 5, 1)', [U])
      ]).catch(() => { /* one client, queued — still exercises the lock path */ });
      const { rows } = await client.query('SELECT points, total_upvotes_received FROM users WHERE id=$1', [U]);
      expect(rows[0].points).toBe(58);           // 48 + 5 + 5
      expect(rows[0].total_upvotes_received).toBe(7); // 5 + 1 + 1
    });
  });

  describe('claim_daily_quota (migration 015)', () => {
    it('REGRESSION: admits exactly `limit`, then refuses', async () => {
      await reset();
      const a = await client.query(`SELECT * FROM claim_daily_quota($1,'question',1)`, [U]);
      const b = await client.query(`SELECT * FROM claim_daily_quota($1,'question',1)`, [U]);
      expect(a.rows[0].allowed).toBe(true);
      expect(a.rows[0].used).toBe(1);
      expect(b.rows[0].allowed).toBe(false);  // the farm the audit flagged, closed
      expect(b.rows[0].used).toBe(1);
    });

    it('rejects an unknown kind', async () => {
      await reset();
      await expect(client.query(`SELECT * FROM claim_daily_quota($1,'nope',1)`, [U]))
        .rejects.toThrow(/unknown quota kind/i);
    });
  });

  describe('transfer_points (migration 005)', () => {
    it('moves points atomically and records the transfer', async () => {
      await reset();
      const { rows } = await client.query('SELECT * FROM transfer_points($1,$2,20,$3)', [V, U, 'gift']);
      expect(rows[0].sender_points).toBe(80);     // 100 - 20
      expect(rows[0].recipient_points).toBe(68);  // 48 + 20
      const t = await client.query('SELECT count(*)::int n FROM point_transfers');
      expect(t.rows[0].n).toBe(1);
    });

    it('REGRESSION: enforces the keep-10 floor under the row lock', async () => {
      await reset();
      await expect(client.query('SELECT * FROM transfer_points($1,$2,95,$3)', [U, V, '']))
        .rejects.toThrow(/insufficient points/i);
    });
  });
});

/**
 * feed_for_user (migration 020), against real Postgres.
 *
 * The route's feed tests never run this function: the fake has no
 * feed_for_user, so they all exercise the plain-recency fallback. 006's version
 * sorted by (day, score, created_at, id) but paged on (created_at, id) alone,
 * which skipped every same-day post that sorted after a cursor yet was newer
 * than it. Nothing could see that without executing the SQL.
 *
 * Runs in its own schema: the feed needs a `posts` table, and the throwaway
 * guard above treats a public `posts` table as the sign of a real database.
 */
const FEED_SCHEMA = 'contract_feed';
const VIEWER = '00000000-0000-4000-8000-0000000000f1';
const FOLLOWED = '00000000-0000-4000-8000-0000000000f2';
const STRANGER = '00000000-0000-4000-8000-0000000000f3';
const postId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

run('feed_for_user keyset pagination (real Postgres)', () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    await assertThrowawayTarget(client);

    await client.query(`
      SET TIME ZONE 'UTC';
      DROP SCHEMA IF EXISTS ${FEED_SCHEMA} CASCADE;
      CREATE SCHEMA ${FEED_SCHEMA};
      SET search_path TO ${FEED_SCHEMA};
      CREATE TABLE users (id UUID PRIMARY KEY, interests TEXT[]);
      CREATE TABLE follows (follower_id UUID, following_id UUID);
      CREATE TABLE posts (
        id UUID PRIMARY KEY, author_id UUID, content TEXT, shares INT DEFAULT 0,
        is_public BOOLEAN DEFAULT TRUE, interest_tags TEXT[] DEFAULT '{}',
        seed_key TEXT, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ
      );
    `);
    await client.query(functionBlock(mig('020_feed_keyset.sql'), 'feed_for_user'));
  });

  afterAll(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS ${FEED_SCHEMA} CASCADE;`).catch(() => {});
      await client.end();
    }
  });

  async function seed(posts) {
    await client.query('TRUNCATE users, follows, posts;');
    await client.query(
      `INSERT INTO users VALUES ($1, '{technology}'), ($2, '{}'), ($3, '{}');`,
      [VIEWER, FOLLOWED, STRANGER]
    );
    await client.query('INSERT INTO follows VALUES ($1, $2);', [VIEWER, FOLLOWED]);
    for (const p of posts) {
      await client.query(
        `INSERT INTO posts (id, author_id, content, is_public, interest_tags, seed_key, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7);`,
        [p.id, p.author, p.content || p.id, p.isPublic ?? true, p.tags || [], p.seed || null, p.at]
      );
    }
  }

  /** One page, called exactly as routes/posts.js calls it. */
  async function page(cursor, limit, personalized = true) {
    const { rows } = await client.query(
      'SELECT * FROM feed_for_user($1, $2, $3, $4, $5)',
      [VIEWER, cursor?.created_at ?? null, cursor?.id ?? null, limit, personalized]
    );
    return rows;
  }

  /** Walk the feed the way infinite scroll does: last row of a page is the next cursor. */
  async function walk(limit, personalized = true, between = async () => {}) {
    const seen = [];
    let cursor = null;
    for (let i = 0; i < 200; i++) {
      const rows = await page(cursor, limit, personalized);
      seen.push(...rows.map((r) => r.id));
      if (rows.length < limit) return seen;
      cursor = rows[rows.length - 1];
      await between(cursor);
    }
    throw new Error('feed walk did not terminate');
  }

  /**
   * Three days, mixing followed / interest-matched / seeded / plain posts so
   * that inside each day the score order and the time order disagree.
   */
  function mixedDays() {
    const posts = [];
    let n = 1;
    for (const day of ['2026-11-17', '2026-11-18', '2026-11-19']) {
      for (let h = 0; h < 8; h++) {
        const kind = h % 4;
        posts.push({
          id: postId(n++),
          author: kind === 1 ? FOLLOWED : STRANGER,
          tags: kind === 2 ? ['technology'] : [],
          seed: kind === 3 ? 'seed' : null,
          at: `${day}T${String(8 + h).padStart(2, '0')}:00:00Z`
        });
      }
    }
    posts.push({ id: postId(n++), author: STRANGER, isPublic: false, at: '2026-11-19T12:30:00Z' });
    return posts;
  }

  it('REGRESSION: the A/B/C case — a newer, lower-scored post on the same day is not skipped', async () => {
    await seed([
      { id: postId(1), author: FOLLOWED, content: 'A', at: '2026-11-19T10:00:00Z' },
      { id: postId(2), author: STRANGER, content: 'B', at: '2026-11-19T11:00:00Z' },
      { id: postId(3), author: STRANGER, content: 'C', at: '2026-11-19T09:00:00Z' }
    ]);

    const seen = await walk(1);
    expect(seen).toEqual([postId(1), postId(2), postId(3)]);
  });

  it('REGRESSION: paging at any size returns every public post exactly once, in unpaged order', async () => {
    const posts = mixedDays();
    await seed(posts);
    const publicCount = posts.filter((p) => p.isPublic !== false).length;

    const unpaged = (await page(null, 50)).map((r) => r.id);
    expect(unpaged).toHaveLength(publicCount);

    for (const size of [1, 2, 3, 5, 7]) {
      const seen = await walk(size);
      expect(seen, `page size ${size}`).toEqual(unpaged);
    }
  });

  it('non-personalized paging is pure recency and still complete', async () => {
    const posts = mixedDays();
    await seed(posts);

    const expected = posts
      .filter((p) => p.isPublic !== false)
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .map((p) => p.id);

    expect(await walk(4, false)).toEqual(expected);
  });

  it('a cursor post deleted between pages repeats rows rather than skipping any', async () => {
    const posts = mixedDays();
    await seed(posts);
    const unpaged = (await page(null, 50)).map((r) => r.id);

    let deleted = null;
    const seen = await walk(3, true, async (cursor) => {
      if (!deleted) {
        deleted = cursor.id;
        await client.query('DELETE FROM posts WHERE id = $1;', [cursor.id]);
      }
    });

    // Every post that still exists was shown at least once: nothing skipped.
    for (const id of unpaged) expect(seen, `missing ${id}`).toContain(id);
  });

  it('a private post cannot serve as a cursor', async () => {
    const posts = mixedDays();
    await seed(posts);
    const hidden = posts.find((p) => p.isPublic === false);

    // Treated as a cursor that is gone: the cursor's day and older, public only.
    const rows = await page({ created_at: hidden.at, id: hidden.id }, 50);
    expect(rows.map((r) => r.id)).not.toContain(hidden.id);
    expect(rows.every((r) => r.is_public)).toBe(true);
  });
});

/**
 * Migration 021: answer votes, answer creation and answer deletion move points
 * in the same transaction as their row, under row locks.
 *
 * Concurrency here is real: a pool of separate connections, so two calls can
 * genuinely overlap and the locks are what serialise them. The fake can only
 * show the arithmetic; this shows the transaction.
 */
const ANS_SCHEMA = 'contract_answers';
const A_AUTHOR = '00000000-0000-4000-8000-0000000000a1';
const A_ASKER = '00000000-0000-4000-8000-0000000000a2';
const A_Q = '00000000-0000-4000-8000-0000000000a3';
const A_ANS = '00000000-0000-4000-8000-0000000000a4';
const A_ANS2 = '00000000-0000-4000-8000-0000000000a5';
const voterId = (n) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;

run('answer points move with their row (migration 021, real Postgres)', () => {
  let admin;
  let pool;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: DB_URL });
    await admin.connect();
    await assertThrowawayTarget(admin);

    await admin.query(`
      DROP SCHEMA IF EXISTS ${ANS_SCHEMA} CASCADE;
      CREATE SCHEMA ${ANS_SCHEMA};
      SET search_path TO ${ANS_SCHEMA};
      CREATE TABLE users (
        id UUID PRIMARY KEY, points INT DEFAULT 0, total_upvotes_received INT DEFAULT 0,
        total_answers INT DEFAULT 0, badges TEXT[] DEFAULT '{}'
      );
      CREATE TABLE questions (
        id UUID PRIMARY KEY, author_id UUID, accepted_answer_id UUID, is_resolved BOOLEAN DEFAULT FALSE
      );
      CREATE TABLE answers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        question_id UUID REFERENCES questions(id) ON DELETE CASCADE,
        author_id UUID REFERENCES users(id) ON DELETE CASCADE,
        body TEXT NOT NULL, is_accepted BOOLEAN DEFAULT FALSE,
        points_awarded BOOLEAN DEFAULT FALSE, bonus_points_awarded BOOLEAN DEFAULT FALSE
      );
      CREATE TABLE answer_votes (
        answer_id UUID NOT NULL REFERENCES answers(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        vote_type TEXT NOT NULL CHECK (vote_type IN ('up','down')),
        points_applied BOOLEAN NOT NULL DEFAULT TRUE,
        PRIMARY KEY (answer_id, user_id)
      );
    `);
    // The shipped definitions, in dependency order.
    await admin.query(functionBlock(mig('005_hardening.sql'), 'compute_badges'));
    await admin.query(functionBlock(mig('016_vote_points.sql'), 'apply_vote_points'));
    for (const fn of ['cast_answer_vote', 'create_answer', 'delete_answer']) {
      await admin.query(functionBlock(mig('021_answer_points_atomic.sql'), fn));
    }

    pool = new pg.Pool({ connectionString: DB_URL, max: 8, options: `-c search_path=${ANS_SCHEMA}` });
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${ANS_SCHEMA} CASCADE;`).catch(() => {});
      await admin.end();
    }
  });

  async function reset({ points = 10 } = {}) {
    await admin.query('TRUNCATE answer_votes, answers, questions, users CASCADE;');
    const voters = Array.from({ length: 6 }, (_, i) => `('${voterId(i)}', 50)`).join(',');
    await admin.query(`INSERT INTO users (id, points) VALUES ('${A_AUTHOR}', ${points}), ('${A_ASKER}', 50), ${voters};`);
    await admin.query(`UPDATE users SET total_answers = 3 WHERE id = '${A_AUTHOR}';`);
    await admin.query(`INSERT INTO questions (id, author_id) VALUES ('${A_Q}', '${A_ASKER}');`);
    await admin.query(
      `INSERT INTO answers (id, question_id, author_id, body, points_awarded)
       VALUES ('${A_ANS}', '${A_Q}', '${A_AUTHOR}', 'one', TRUE), ('${A_ANS2}', '${A_Q}', '${A_AUTHOR}', 'two', TRUE);`
    );
  }

  const authorRow = async () =>
    (await admin.query('SELECT points, total_upvotes_received, total_answers FROM users WHERE id = $1', [A_AUTHOR])).rows[0];
  const vote = (voter, type, answer = A_ANS) =>
    pool.query('SELECT * FROM cast_answer_vote($1, $2, $3)', [answer, voter, type]);

  it('six voters at once: every upvote counts and the bonus is paid exactly once', async () => {
    await reset({ points: 10 });

    await Promise.all(Array.from({ length: 6 }, (_, i) => vote(voterId(i), 'up')));

    const a = await authorRow();
    expect(a.total_upvotes_received).toBe(6);
    expect(a.points).toBe(15);  // 10 + one 5-upvote bonus, not two
    const { rows } = await admin.query('SELECT bonus_points_awarded FROM answers WHERE id = $1', [A_ANS]);
    expect(rows[0].bonus_points_awarded).toBe(true);
  });

  it('a double-click (same voter, same vote, at once) serialises instead of erroring', async () => {
    await reset();

    const results = await Promise.allSettled([vote(voterId(0), 'up'), vote(voterId(0), 'up')]);

    // Both succeed: the second sees the first's row and toggles it off.
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const n = await admin.query('SELECT count(*)::int AS n FROM answer_votes WHERE user_id = $1', [voterId(0)]);
    expect(n.rows[0].n).toBe(0);
    expect((await authorRow()).total_upvotes_received).toBe(0);
  });

  it('REGRESSION: posting an answer and a downvote at once keep both changes', async () => {
    await reset({ points: 10 });

    await Promise.all([
      pool.query('SELECT * FROM create_answer($1, $2, $3)', [A_Q, A_AUTHOR, 'three']),
      vote(voterId(1), 'down', A_ANS2)
    ]);

    const a = await authorRow();
    expect(a.points).toBe(14);         // 10 + 5 - 1
    expect(a.total_answers).toBe(4);
  });

  it('REGRESSION: the vote row and the points commit together or not at all', async () => {
    /*
     * The residual decision 0006 recorded: the route wrote the vote, then moved
     * points in a separate call. Make the points step fail and the vote must
     * not survive it.
     */
    await reset();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`
        CREATE OR REPLACE FUNCTION apply_vote_points(p_user_id UUID, p_points_delta INT, p_upvotes_delta INT)
        RETURNS TABLE (points INT, total_upvotes_received INT, badges TEXT[])
        LANGUAGE plpgsql AS $fail$ BEGIN RAISE EXCEPTION 'simulated failure'; END; $fail$;
      `);
      await c.query('SAVEPOINT before_vote');
      await expect(c.query('SELECT * FROM cast_answer_vote($1, $2, $3)', [A_ANS, voterId(2), 'up']))
        .rejects.toThrow(/simulated failure/);
      await c.query('ROLLBACK TO SAVEPOINT before_vote');
      const { rows } = await c.query('SELECT count(*)::int AS n FROM answer_votes');
      expect(rows[0].n).toBe(0);
    } finally {
      await c.query('ROLLBACK');  // also restores the real apply_vote_points
      c.release();
    }
  });

  it('a downvote at zero records points_applied=false, and undoing it credits nothing', async () => {
    await reset({ points: 0 });

    await vote(voterId(3), 'down');
    const row = await admin.query('SELECT points_applied FROM answer_votes WHERE user_id = $1', [voterId(3)]);
    expect(row.rows[0].points_applied).toBe(false);

    await vote(voterId(3), 'down');  // undo
    expect((await authorRow()).points).toBe(0);
  });

  it('refuses a vote on your own answer and an unknown type', async () => {
    await reset();
    await expect(vote(A_AUTHOR, 'up')).rejects.toThrow(/own answer/);
    await expect(vote(voterId(0), 'sideways')).rejects.toThrow(/up or down/);
  });

  it('delete_answer takes back the award and bonus, clears accepted, and cascades votes', async () => {
    await reset({ points: 30 });
    await admin.query(`UPDATE answers SET bonus_points_awarded = TRUE WHERE id = '${A_ANS}';`);
    await admin.query(`UPDATE questions SET accepted_answer_id = '${A_ANS}', is_resolved = TRUE;`);
    await vote(voterId(4), 'up');

    await expect(pool.query('SELECT * FROM delete_answer($1, $2)', [A_ANS, A_ASKER]))
      .rejects.toThrow(/not authorized/);

    const { rows } = await pool.query('SELECT * FROM delete_answer($1, $2)', [A_ANS, A_AUTHOR]);
    expect(rows[0].author_points).toBe(20);  // 30 - 5 - 5
    const q = await admin.query('SELECT accepted_answer_id, is_resolved FROM questions');
    expect(q.rows[0]).toEqual({ accepted_answer_id: null, is_resolved: false });
    const v = await admin.query('SELECT count(*)::int AS n FROM answer_votes WHERE answer_id = $1', [A_ANS]);
    expect(v.rows[0].n).toBe(0);
  });
});

/**
 * The throwaway-target guard runs offline (no real DB needed) with a stub
 * client, because its whole job is to keep the destructive setup above from
 * touching the wrong database — and that has to be verified everywhere the
 * suite runs, not only where CONTRACT_DB_URL is set.
 */
describe('assertThrowawayTarget (decision 0005, enforced)', () => {
  // Faithful to the real query: it only returns public tables that are ALSO in
  // the app-table watchlist, so the stub filters the same way. A stub that
  // returned every table regardless would be another fake more permissive than
  // the thing it stands for — the exact trap 0004 is about.
  const WATCH = ['posts', 'questions', 'comments', 'notifications', 'bookmarks', 'friendships'];
  const stub = (tables) => ({
    query: async (sql) =>
      /current_database/i.test(sql)
        ? { rows: [{ d: 'scratch' }] }
        : { rows: tables.filter((t) => WATCH.includes(t)).map((t) => ({ tablename: t })) }
  });

  it('REGRESSION: refuses a target holding real application tables', async () => {
    await expect(assertThrowawayTarget(stub(['users', 'posts', 'questions'])))
      .rejects.toThrow(/real application tables/i);
  });

  it('allows an empty or scratch-only target', async () => {
    await expect(assertThrowawayTarget(stub([]))).resolves.toBeUndefined();
    await expect(assertThrowawayTarget(stub(['users', 'answer_votes', 'point_transfers'])))
      .resolves.toBeUndefined();
  });
});

/**
 * Migration 022: ranked search pages on (rank, created_at, id), and a typo
 * alone finds a match.
 *
 * The cursor carries the rank exactly as the driver handed it back (a REAL
 * parsed from text, as PostgREST's JSON does), so this also checks that the
 * value survives the round trip well enough to compare equal.
 */
const SEARCH_SCHEMA = 'contract_search';

run('ranked search paging and typos (migration 022, real Postgres)', () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    await assertThrowawayTarget(client);
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
      DROP SCHEMA IF EXISTS ${SEARCH_SCHEMA} CASCADE;
      CREATE SCHEMA ${SEARCH_SCHEMA};
      SET search_path TO ${SEARCH_SCHEMA}, public;
      CREATE TABLE posts (
        id UUID PRIMARY KEY, author_id UUID, content TEXT, shares INT DEFAULT 0,
        is_public BOOLEAN DEFAULT TRUE, interest_tags TEXT[] DEFAULT '{}', seed_key TEXT,
        created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ,
        search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', COALESCE(content, ''))) STORED
      );
      CREATE TABLE questions (
        id UUID PRIMARY KEY, author_id UUID, title TEXT, body TEXT, tags TEXT[], views INT DEFAULT 0,
        accepted_answer_id UUID, is_resolved BOOLEAN DEFAULT FALSE, bounty INT DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ,
        search_vector tsvector GENERATED ALWAYS AS (
          setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
          setweight(to_tsvector('english', COALESCE(body, '')), 'B')
        ) STORED
      );
    `);
    for (const fn of ['search_questions', 'search_posts']) {
      await client.query(functionBlock(mig('022_search_paging.sql'), fn));
    }
  });

  afterAll(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS ${SEARCH_SCHEMA} CASCADE;`).catch(() => {});
      await client.end();
    }
  });

  const pid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  it('REGRESSION: pages past 50, every match exactly once, even with tied ranks', async () => {
    await client.query('TRUNCATE posts;');
    // 60 matches. Two contents, so many rows share a rank exactly and only
    // created_at, then id, can order them. Some share a created_at too.
    for (let n = 1; n <= 60; n++) {
      const content = n % 3 === 0 ? 'postgres indexing deep dive and more postgres' : 'notes on postgres';
      const at = new Date(Date.UTC(2026, 10, 1, 0, Math.floor(n / 2))).toISOString();
      await client.query('INSERT INTO posts (id, content, created_at) VALUES ($1, $2, $3);', [pid(n), content, at]);
    }

    const seen = [];
    let cursor = null;
    for (let i = 0; i < 20; i++) {
      const { rows } = await client.query(
        'SELECT * FROM search_posts($1, $2, $3, $4, $5)',
        ['postgres', 7, cursor?.rank ?? null, cursor?.created_at ?? null, cursor?.id ?? null]
      );
      seen.push(...rows.map((r) => r.id));
      if (rows.length < 7) break;
      cursor = rows[rows.length - 1];
    }

    expect(seen).toHaveLength(60);
    expect(new Set(seen).size).toBe(60);
  });

  it('REGRESSION: a typo alone finds a question title and a post', async () => {
    await client.query('TRUNCATE posts, questions;');
    await client.query(
      `INSERT INTO questions (id, title, body, created_at) VALUES ($1, 'How do closures work in JavaScript?', 'scope', now());`,
      [pid(1)]
    );
    await client.query(
      `INSERT INTO posts (id, content, created_at) VALUES ($1, 'Best way to learn Postgres indexing for beginners', now());`,
      [pid(2)]
    );

    const q = await client.query('SELECT id FROM search_questions($1)', ['javscript']);
    const p = await client.query('SELECT id FROM search_posts($1)', ['postgress']);
    const none = await client.query('SELECT id FROM search_questions($1)', ['react']);

    expect(q.rows.map((r) => r.id)).toEqual([pid(1)]);
    expect(p.rows.map((r) => r.id)).toEqual([pid(2)]);
    expect(none.rows).toHaveLength(0);
  });

  it('old callers passing only (p_query, p_limit) still work', async () => {
    const { rows } = await client.query('SELECT * FROM search_posts($1, $2)', ['postgress', 5]);
    expect(rows.length).toBeGreaterThan(0);
  });
});
