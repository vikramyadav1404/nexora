/**
 * Checking that the race-guard SQL functions exist and actually run.
 *
 * This lives in utils/ rather than scripts/ for one hard-learned reason: the
 * boot health check in index.js requires it, and the Vercel serverless bundle
 * traces requires from utils/ reliably (index.js pulls in many of them),
 * whereas a require reaching into scripts/ is a bundling gamble that would only
 * fail in production. After a boot require that does not resolve there is no
 * graceful 503 -- the function invocation just fails. So the code the boot
 * depends on stays where the bundler certainly follows it.
 *
 * The three functions -- apply_vote_points (016), claim_daily_quota (015),
 * transfer_points (005) -- make points and quota race-safe. Each probe calls
 * one with a nil UUID; every one RAISEs "not found" before reaching any UPDATE,
 * so the probes write nothing and are safe to run read-only against any
 * environment, production included.
 *
 * Outcomes, from what PostgREST/Postgres returns:
 *   PGRST202               -> MISSING   (migration not applied)
 *   42702 / any other code -> BROKEN    (present but does not run -- the 016 bug)
 *   its own domain error   -> PRESENT   (P0002 "not found" / no_data_found)
 *   success                -> PRESENT
 */

const NIL_A = '00000000-0000-4000-8000-000000000000';
const NIL_B = '00000000-0000-4000-8000-000000000001';

// name -> [args, the domain error a healthy function raises for a nil id]
const PROBES = {
  apply_vote_points: [{ p_user_id: NIL_A, p_points_delta: 0, p_upvotes_delta: 0 }, /not found/i],
  claim_daily_quota: [{ p_user_id: NIL_A, p_kind: 'question', p_limit: 1 }, /not found/i],
  transfer_points: [{ p_from_user: NIL_A, p_to_user: NIL_B, p_points: 1, p_message: '' }, /not found/i]
};

function classify(error, healthyPattern) {
  if (!error) return { state: 'PRESENT', detail: 'ran' };
  if (error.code === 'PGRST202') return { state: 'MISSING', detail: 'migration not applied' };
  if (healthyPattern.test(error.message || '') || error.code === 'P0002') {
    return { state: 'PRESENT', detail: 'ran (raised its own not-found)' };
  }
  return { state: 'BROKEN', detail: `${error.code || '?'}: ${(error.message || '').slice(0, 60)}` };
}

/**
 * @param {object} db a Supabase client
 * @returns {Promise<Record<string,{state:string,detail:string}>>}
 */
async function verifyRaceFunctions(db) {
  const results = {};
  for (const [name, [args, pattern]] of Object.entries(PROBES)) {
    const { error } = await db.rpc(name, args);
    results[name] = classify(error, pattern);
  }
  return results;
}

module.exports = { verifyRaceFunctions, classify, PROBES };
