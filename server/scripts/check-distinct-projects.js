#!/usr/bin/env node
/**
 * Prove two Supabase projects are genuinely different, with a check that can fail.
 *
 * Usage:
 *   node scripts/check-distinct-projects.js .env .env.staging
 *
 * ------------------------------------------------------------------
 * Why this does not compare strings
 * ------------------------------------------------------------------
 * The first version of this check compared production's SUPABASE_URL against
 * staging's and reported "different projects". Both were true and it was
 * worthless: `vercel env pull` had returned the literal string "[SENSITIVE]",
 * so it was comparing a real URL against a placeholder. Any two different
 * strings differ. There was no input that could have made it say "same", which
 * means it was not a check at all.
 *
 * So this asks the servers instead. A configuration value can be wrong; an
 * authentication outcome is the project's own answer about a credential, and
 * nothing in a .env file can fake it.
 *
 * ------------------------------------------------------------------
 * The matrix
 * ------------------------------------------------------------------
 *   A-key -> A-url    expect 200   positive control: the probe works at all
 *   B-key -> B-url    expect 200   positive control: B's credential is real
 *   B-key -> A-url    expect 401   B has no power over A
 *   A-key -> B-url    expect 401   and the reverse
 *
 * If A and B are the same project, the two cross probes return 200 and this
 * fails loudly. That is the outcome the old check could not express.
 *
 * The positive controls are what make the negatives mean anything. Without
 * them, a network fault or a typo'd hostname produces 401 everywhere and reads
 * as perfect isolation -- the same false green, one layer along.
 *
 * Run with the same file twice to see it fail. It should report SAME PROJECT.
 */

const fs = require('fs');

const URL_SHAPE = /^https:\/\/[a-z0-9]{20}\.supabase\.co$/;

function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const name = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[name] = value;
  }
  return out;
}

/** Reject placeholders and junk before any request, so nothing is compared blind. */
function validate(label, env) {
  const url = (env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!url) throw new Error(`${label}: SUPABASE_URL is absent`);
  if (!key) throw new Error(`${label}: SUPABASE_SERVICE_ROLE_KEY is absent`);
  if (url === '[SENSITIVE]' || key === '[SENSITIVE]') {
    throw new Error(
      `${label}: value is the literal "[SENSITIVE]" — vercel env pull redacted it. ` +
      'Pull with --git-branch=<branch>. Comparing this would prove nothing.'
    );
  }
  if (!URL_SHAPE.test(url)) {
    throw new Error(`${label}: SUPABASE_URL is not a project URL (${url.slice(0, 40)})`);
  }
  return { label, url, key, ref: url.slice('https://'.length, -'.supabase.co'.length) };
}

/** Does this credential authenticate against this project? */
async function probe(key, url) {
  const res = await fetch(`${url}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  return res.status;
}

async function main() {
  const [fileA, fileB] = process.argv.slice(2);
  if (!fileA || !fileB) {
    console.error('\nUsage: node scripts/check-distinct-projects.js <envA> <envB>\n');
    process.exitCode = 1;
    return;
  }

  const a = validate(`A (${fileA})`, readEnv(fileA));
  const b = validate(`B (${fileB})`, readEnv(fileB));

  console.log(`\n  A  ${fileA.padEnd(16)} ref ${a.ref}`);
  console.log(`  B  ${fileB.padEnd(16)} ref ${b.ref}\n`);

  /*
   * Sequential, not Promise.all.
   *
   * Run concurrently, the self-test (same file twice) issues two identical
   * requests at once and one of them intermittently came back 401 -- same key,
   * same URL, different answer. Whether that is rate limiting or a connection
   * race does not much matter: a check whose verdict can depend on request
   * timing is not a check you can rely on to say "these are different
   * databases". Four sequential requests cost about a second.
   */
  const aa = await probe(a.key, a.url);
  const bb = await probe(b.key, b.url);
  const ba = await probe(b.key, a.url);
  const ab = await probe(a.key, b.url);

  const rows = [
    ['A key -> A url', aa, 200, 'positive control: the probe works'],
    ['B key -> B url', bb, 200, 'positive control: B credential is real'],
    ['B key -> A url', ba, 401, 'B has no power over A'],
    ['A key -> B url', ab, 401, 'A has no power over B']
  ];

  let ok = true;
  for (const [name, got, want, why] of rows) {
    const pass = got === want;
    if (!pass) ok = false;
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  got ${got}, want ${want}   ${why}`);
  }

  console.log('');

  /*
   * Both cross probes succeeding is the signature of one project wearing two
   * names -- which is exactly the situation every downstream guard assumes is
   * impossible.
   */
  if (ba === 200 && ab === 200) {
    console.error('  SAME PROJECT: each credential works against the other URL.\n');
    process.exitCode = 1;
    return;
  }

  if (!ok) {
    console.error('  INCONCLUSIVE: the matrix did not come out as expected. Do not proceed.\n');
    process.exitCode = 1;
    return;
  }

  console.log('  DISTINCT: each credential authenticates only against its own project.\n');
}

main().catch((err) => {
  console.error('\n  Check failed:', err.message, '\n');
  process.exitCode = 1;
});
