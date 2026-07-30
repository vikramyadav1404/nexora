#!/usr/bin/env node
/**
 * Backs up every table to a timestamped JSON file.
 *
 *   npm run backup
 *
 * Why this exists: the previous Supabase project was lost and its data went
 * with it. Free-tier Supabase has no point-in-time recovery, so the only
 * protection is a copy you hold yourself.
 *
 * Uses the REST API rather than pg_dump so it needs no Postgres client
 * installed — just the service_role key already in server/.env.
 *
 * Restore with:  npm run restore -- backups/<file>.json
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getSupabase } = require('../db/supabase');

const TABLES = [
  'users', 'friendships', 'friend_requests', 'follows',
  'posts', 'post_media', 'post_likes', 'post_comments',
  'questions', 'question_votes', 'answers', 'answer_votes',
  'transactions', 'point_transfers',
  'notifications', 'bookmarks', 'blocks', 'reports'
];

const PAGE = 1000;

async function dumpTable(db, table) {
  const rows = [];
  // Page through — a single select would silently cap at PostgREST's limit.
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from(table).select('*').range(from, from + PAGE - 1);
    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) return null; // table absent
      throw new Error(`${table}: ${error.message}`);
    }
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

(async () => {
  if (process.env.DEMO_MODE === 'true' || process.env.DEMO_MODE === '1') {
    console.error('DEMO_MODE is on — there is no real database to back up.');
    console.error('Set DEMO_MODE=false in server/.env first.');
    process.exit(1);
  }

  let db;
  try {
    db = getSupabase();
  } catch (err) {
    console.error('Cannot reach the database:', err.message);
    process.exit(1);
  }

  const dir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = { takenAt: new Date().toISOString(), tables: {} };
  let total = 0;
  const skipped = [];

  for (const table of TABLES) {
    try {
      const rows = await dumpTable(db, table);
      if (rows === null) { skipped.push(table); continue; }
      out.tables[table] = rows;
      total += rows.length;
      console.log(`  ${String(rows.length).padStart(6)}  ${table}`);
    } catch (err) {
      console.error(`  FAILED  ${table} — ${err.message}`);
      process.exitCode = 1;
    }
  }

  // Passwords are bcrypt hashes, but this file is still sensitive — it holds
  // every email address in the system. backups/ is gitignored.
  const file = path.join(dir, `nexora-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));

  console.log('');
  console.log(`${total} rows across ${Object.keys(out.tables).length} tables`);
  if (skipped.length) console.log(`skipped (not in this database): ${skipped.join(', ')}`);
  console.log(`saved -> ${path.relative(process.cwd(), file)}`);
  console.log('');
  console.log('Keep a copy somewhere off this machine. This file contains every');
  console.log('user email address, so treat it like a password.');
})();
