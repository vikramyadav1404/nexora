#!/usr/bin/env node
/**
 * Run SQL against a Supabase project over the Management API.
 *
 * Usage:
 *   node scripts/supabase-sql.js --ref <ref> --confirm <ref> --sql "select 1"
 *   node scripts/supabase-sql.js --ref <ref> --confirm <ref> --file path.sql
 *
 * Needs SUPABASE_ACCESS_TOKEN (a Personal Access Token, sbp_...) in the
 * environment or in server/.env.staging.
 *
 * ------------------------------------------------------------------
 * Why this exists instead of psql
 * ------------------------------------------------------------------
 * The staging database password could not be authenticated from here by any
 * route: session pooler, transaction pooler and the direct host, across two
 * psql versions, both URI and PGPASSWORD forms, with and without sslmode and
 * channel binding, using three separately-generated passwords. Every attempt
 * returned "password authentication failed" while the same project answered
 * 200 on PostgREST with its service key.
 *
 * The cause was never established. This route sidesteps it: the Management API
 * is the mechanism the dashboard SQL editor uses, it authenticates with an
 * account token rather than a database password, and it is plain HTTPS -- no
 * pooler hostname, IPv6, SSL mode or channel-binding variables to get wrong.
 *
 * ------------------------------------------------------------------
 * This is a loaded gun, so it has a safety
 * ------------------------------------------------------------------
 * A script that runs arbitrary SQL against a named project is exactly the tool
 * that should not exist without a guard. The important one is not `--confirm`
 * -- that only proves the operator typed the ref twice, and someone running the
 * wrong command usually types the wrong thing consistently.
 *
 * The one that matters is the refusal to target production at all. The
 * production ref is read from server/.env and rejected outright. There is no
 * flag to override it, because a flag would eventually be passed.
 */

const fs = require('fs');
const path = require('path');

const API = 'https://api.supabase.com';
const REF_SHAPE = /^[a-z]{20}$/;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[t.slice(0, i).trim()] = v;
  }
  return out;
}

/** The one target this tool must never accept. */
function productionRef() {
  const env = readEnvFile(path.join(__dirname, '..', '.env'));
  const url = env.SUPABASE_URL || '';
  const m = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/);
  return m ? m[1] : null;
}

async function runQuery(token, ref, sql) {
  const res = await fetch(`${API}/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql })
  });

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }

  if (!res.ok) {
    const detail = typeof body === 'string' ? body : (body.message || body.error || JSON.stringify(body));
    throw new Error(`HTTP ${res.status}: ${String(detail).slice(0, 400)}`);
  }
  return body;
}

async function main() {
  const ref = arg('--ref');
  const confirm = arg('--confirm');
  const sqlInline = arg('--sql');
  const file = arg('--file');

  const staging = readEnvFile(path.join(__dirname, '..', '.env.staging'));
  const token = process.env.SUPABASE_ACCESS_TOKEN || staging.SUPABASE_ACCESS_TOKEN || '';

  const problems = [];
  if (!token) problems.push('SUPABASE_ACCESS_TOKEN is not set (a Personal Access Token, sbp_...)');
  if (!token.startsWith('sbp_') && token) problems.push('SUPABASE_ACCESS_TOKEN does not look like a PAT (expected sbp_...)');
  if (!ref) problems.push('--ref <project-ref> is required');
  if (ref && !REF_SHAPE.test(ref)) problems.push(`--ref "${ref}" is not a 20-letter project ref`);
  if (!confirm) problems.push('--confirm <project-ref> is required');
  if (ref && confirm && ref !== confirm) problems.push('--ref and --confirm do not match');
  if (!sqlInline && !file) problems.push('one of --sql or --file is required');

  /*
   * The guard that actually matters, checked before anything else can go wrong.
   * No override flag: a flag is a thing that gets passed.
   */
  const prod = productionRef();
  if (ref && prod && ref === prod) {
    console.error('\n  REFUSING: that is the production project.\n');
    console.error('  This tool runs arbitrary SQL. It does not point at production,');
    console.error('  and there is deliberately no flag to make it.\n');
    process.exitCode = 1;
    return;
  }

  if (problems.length) {
    console.error('\n  Cannot run:\n');
    for (const p of problems) console.error('    - ' + p);
    console.error('');
    process.exitCode = 1;
    return;
  }

  const sql = file ? fs.readFileSync(file, 'utf8') : sqlInline;

  if (file) {
    // Rough, but enough to notice "I meant to run one statement" before it runs 200.
    const statements = sql.split(';').map(s => s.trim()).filter(s => s && !s.startsWith('--')).length;
    console.log(`\n  ${path.basename(file)}: ~${statements} statements, ${sql.length} bytes`);
    console.log(`  target: ${ref}\n`);
  }

  const result = await runQuery(token, ref, sql);
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
}

main().catch((err) => {
  // Never let a token reach the output, even inside an error string.
  const token = process.env.SUPABASE_ACCESS_TOKEN || '';
  let msg = err.message;
  if (token) msg = msg.split(token).join('<token>');
  console.error('\n  Failed:', msg, '\n');
  process.exitCode = 1;
});
