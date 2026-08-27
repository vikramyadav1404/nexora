#!/usr/bin/env node
/**
 * Check that the race-guard SQL functions exist and actually run.
 *
 * This is the check whose absence let the whole thing happen. Three functions —
 * apply_vote_points (016), claim_daily_quota (015), transfer_points (005) — make
 * points and quota race-safe. Migration drift left two of them missing from
 * production and one broken on staging, and nothing looked, because the app
 * degrades silently to a racy fallback when a function is absent.
 *
 * Each probe calls a function with a nil UUID. Every one of them RAISEs
 * "not found" before it reaches any UPDATE, so the probes write nothing and are
 * safe to run read-only against any environment, production included.
 *
 * Outcomes, from what PostgREST/Postgres returns:
 *   - PGRST202               → MISSING   (migration not applied)
 *   - 42702 / any other code → BROKEN    (present but does not run — the 016 bug)
 *   - its own domain error   → PRESENT   (P0002 "not found" / no_data_found)
 *   - success                → PRESENT
 *
 * Warn-only by default: production is *currently* missing these, so failing hard
 * now would be failing on the very state this exists to end. Pass --strict once
 * the functions are applied (staging, then production) to make MISSING/BROKEN a
 * non-zero exit — that is the form the boot assertion takes afterward.
 *
 *   node scripts/verify-functions.js            # report, exit 0
 *   node scripts/verify-functions.js --strict   # exit 1 if any missing/broken
 */
require('dotenv').config();
const { getSupabase } = require('../db/supabase');
// The check logic lives in utils/ so the boot assertion in index.js can require
// it without a serverless-bundling gamble. This CLI is the manual/warn-only
// front end for the same function.
const { verifyRaceFunctions, classify, PROBES } = require('../utils/raceFunctions');

async function main() {
  const strict = process.argv.includes('--strict');
  const db = getSupabase();
  const results = await verifyRaceFunctions(db);

  let bad = 0;
  console.log('\n  Race-guard SQL functions:\n');
  for (const [name, { state, detail }] of Object.entries(results)) {
    if (state !== 'PRESENT') bad += 1;
    console.log(`    ${state === 'PRESENT' ? 'ok  ' : state === 'MISSING' ? 'MISS' : 'BAD '}  ${name.padEnd(20)} ${detail}`);
  }
  console.log('');

  if (bad === 0) {
    console.log('  All three present and running.\n');
    return;
  }
  const msg = `  ${bad} function(s) missing or broken — points/quota are running the racy fallback.\n`;
  if (strict) {
    console.error(msg + '  --strict: failing.\n');
    process.exitCode = 1;
  } else {
    console.warn(msg + '  (warn-only; pass --strict to fail once they are applied)\n');
  }
}

// Re-exported for tests. The boot assertion imports from utils/raceFunctions
// directly. Setting process.exitCode rather than calling process.exit keeps the
// Supabase client's handles from aborting the event loop mid-drain on Windows.
module.exports = { verifyRaceFunctions, classify, PROBES };

if (require.main === module) {
  main().catch((err) => {
    console.error('\n  verify-functions failed to run:', err.message, '\n');
    process.exitCode = 1;
  });
}
