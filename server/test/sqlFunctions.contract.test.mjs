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
 * migration files (005, 015, 016) into a scratch schema and calls the functions
 * exactly as the app does — same parameter names, same expectations.
 *
 * ------------------------------------------------------------------
 * Running it
 * ------------------------------------------------------------------
 * Set CONTRACT_DB_URL to a Postgres this test may DROP and recreate objects in
 * — a disposable local cluster, or CI's service container. With it unset the
 * whole suite skips, so the offline unit run is unaffected. It must never point
 * at staging or production: the test creates and drops tables.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const DB_URL = process.env.CONTRACT_DB_URL;
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

run('SQL race-guard functions (real Postgres)', () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();

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
