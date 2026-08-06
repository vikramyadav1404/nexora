#!/usr/bin/env node
/**
 * Build a paste-ready SQL file for the Supabase SQL Editor.
 *
 * The editor takes one paste, so applying four migrations meant keeping four
 * hand-maintained concatenations of the numbered files next to the numbered
 * files themselves — SETUP_ALL.sql, RUN_MISSING.sql, RUN_THIS_IN_SUPABASE.sql
 * and RUN_008_009.sql, 1,808 lines of copies. A fix to 006_feed.sql reached the
 * original and none of the copies, and nothing anywhere said so.
 *
 * Now the numbered files are the only source of truth and the combined file is
 * generated on demand. The output is gitignored, because a generated artifact
 * that is committed is just a copy again.
 *
 *   npm run migration:runner -- 005 006 007 010
 *   npm run migration:runner -- --fresh            # whole schema, new database
 *   npm run migration:runner -- 008 009 --verify   # append a schema check
 */
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const DEFAULT_OUT = path.join(MIGRATIONS_DIR, '_runner.generated.sql');

/** Every numbered migration, in the order Postgres must see them. */
function allMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
}

/**
 * The set to run against an empty database.
 *
 * 000 is excluded: 001 supersedes it entirely. Verified rather than assumed —
 * 001 declares all 38 of 000's users columns plus streak_count,
 * last_activity_date and challenge_progress, and creates notifications,
 * bookmarks, blocks and reports on top of 000's 14 tables. 002 and 003 are kept
 * even though 001 already contains everything they add, because they are pure
 * ADD COLUMN IF NOT EXISTS and cost nothing.
 *
 * This replaces the old hand-maintained SETUP_ALL.sql, which stopped at 007. A
 * database built from that file had no refresh_tokens table and no MFA columns,
 * so sessions died after fifteen minutes and two-factor could not be switched
 * on — a fresh install was broken and nothing said so.
 */
function freshInstall() {
  return allMigrations().filter((f) => !f.startsWith('000_'));
}

/**
 * A closing SELECT that reports whether the objects just created are really
 * there. Derived from the migrations being run, so it cannot drift from them.
 */
function verificationQuery(names) {
  const tables = new Set();
  const columns = new Set();

  for (const name of names) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/gi)) tables.add(m[1]);
    for (const m of sql.matchAll(/ALTER TABLE (\w+)\s+ADD COLUMN IF NOT EXISTS (\w+)/gi)) {
      columns.add(`${m[1]}.${m[2]}`);
    }
  }

  const parts = [];
  for (const t of tables) parts.push(`  to_regclass('public.${t}') AS table_${t}`);
  if (columns.size) {
    const pairs = [...columns].map((c) => {
      const [t, col] = c.split('.');
      return `('${t}','${col}')`;
    });
    parts.push(
      `  (SELECT count(*) FROM information_schema.columns\n` +
      `    WHERE (table_name, column_name) IN (${pairs.join(', ')})\n` +
      `  ) AS columns_found_expected_${columns.size}`
    );
  }

  if (!parts.length) return '';

  return (
    '\n\n-- ############################################################\n' +
    '-- Verification — every value below should be non-null, and the\n' +
    '-- column count should match the number in its own name.\n' +
    '-- ############################################################\n\n' +
    'SELECT\n' + parts.join(',\n') + ';\n'
  );
}

/** Accepts '5', '005', or '005_hardening.sql' — whatever is quickest to type. */
function resolve(token, available) {
  if (available.includes(token)) return token;
  const padded = String(token).padStart(3, '0');
  const hit = available.find((f) => f.startsWith(`${padded}_`));
  if (!hit) {
    throw new Error(
      `No migration matches "${token}". Available: ${available.map((f) => f.slice(0, 3)).join(', ')}`
    );
  }
  return hit;
}

function parseArgs(argv) {
  const out = { files: [], outPath: DEFAULT_OUT, fresh: false, verify: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fresh') out.fresh = true;
    else if (argv[i] === '--verify') out.verify = true;
    else if (argv[i] === '--out') out.outPath = argv[++i];
    else out.files.push(argv[i]);
  }
  return out;
}

function build(names, { verify = false } = {}) {
  const listed = names.map((f) => f.slice(0, 3)).join(', ');

  let sql =
    '-- ============================================================\n' +
    `-- NEXORA — migrations ${listed}\n` +
    '-- ============================================================\n' +
    '--\n' +
    '-- Paste this whole file into the Supabase SQL Editor and press Run.\n' +
    '--\n' +
    '-- GENERATED FILE — do not edit, and do not commit it. Edit the numbered\n' +
    '-- migrations in server/db/migrations/ and regenerate:\n' +
    `--   npm run migration:runner -- ${names.map((f) => f.slice(0, 3)).join(' ')}\n` +
    '--\n' +
    '-- Every statement is idempotent (IF NOT EXISTS, or CREATE OR REPLACE), so\n' +
    '-- running this twice is safe, and running it when some parts are already\n' +
    '-- applied is safe.\n' +
    '-- ============================================================\n';

  for (const name of names) {
    const body = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');

    /*
     * Dollar-quoted function bodies ($$ ... $$) must survive concatenation
     * intact. An odd count means a body was truncated somewhere, and the editor
     * would report a syntax error a hundred lines away from the real cause.
     */
    const dollars = (body.match(/\$\$/g) || []).length;
    if (dollars % 2 !== 0) {
      throw new Error(`${name} has ${dollars} "$$" markers — unbalanced, refusing to build`);
    }

    sql +=
      '\n\n-- ############################################################\n' +
      `-- ${name}\n` +
      '-- ############################################################\n\n' +
      `${body.trimEnd()}\n`;
  }

  return verify ? sql + verificationQuery(names) : sql;
}

function main() {
  const { files, outPath, fresh, verify } = parseArgs(process.argv.slice(2));
  const available = allMigrations();

  if (!fresh && files.length === 0) {
    console.error('Usage: npm run migration:runner -- <numbers...> [--fresh] [--verify] [--out path]');
    console.error('  --fresh   every migration needed by an empty database');
    console.error('  --verify  append a SELECT that checks the objects were created');
    console.error(`Available: ${available.map((f) => f.slice(0, 3)).join(', ')}`);
    process.exit(1);
  }

  const names = fresh ? freshInstall() : files.map((f) => resolve(f, available));
  const sql = build(names, { verify });

  fs.writeFileSync(outPath, sql);

  const lines = sql.split('\n').length;
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}  (${lines} lines)`);
  console.log(`  includes: ${names.join(', ')}`);
  console.log('  Open it, copy everything, paste into the Supabase SQL Editor, press Run.');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { allMigrations, freshInstall, resolve, build, verificationQuery };
