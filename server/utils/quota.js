const { missingFunctionError } = require('./raceFunctions');

/**
 * Take one slot from a user's daily allowance, atomically.
 *
 * The old inline version read the counter from req.userRow (loaded once by
 * protect), checked it, and wrote it back at the end of the request. Two
 * requests arriving together both read 0, both passed the check, and both wrote
 * 1 -- so firing N in parallel gave a free account N questions. The daily limit
 * is the entire difference between the free plan and the paid ones, so that was
 * the paid tiers being bypassable, not just a counter being loose.
 *
 * Migration 015's claim_daily_quota takes a row lock, so callers serialise and
 * each one sees the true count.
 *
 * Call this BEFORE doing the work it gates. Claiming afterwards would let an
 * over-limit question be created and only then be told no; claiming first can
 * at worst burn a slot on a request that then fails, which is the safer
 * direction.
 *
 * Callers still pass `userRow`; it is no longer read. The count always comes
 * from the locked row, never from the copy loaded at the start of the request.
 *
 * @param {'question'|'post'} kind
 * @param {number} limit - Infinity for unlimited
 * @returns {Promise<{allowed: boolean, used: number}>}
 */
async function claimDailyQuota(db, { userId, kind, limit }) {
  const rpcLimit = limit === Infinity ? null : limit;

  const { data, error } = await db.rpc('claim_daily_quota', {
    p_user_id: userId,
    p_kind: kind,
    p_limit: rpcLimit
  });

  if (!error) {
    // PostgREST returns RETURNS TABLE as an array of rows.
    const row = Array.isArray(data) ? data[0] : data;
    return { allowed: !!row?.allowed, used: row?.used ?? 0 };
  }

  /*
   * No error is swallowed into a silent allow -- that would turn a database
   * problem into an unlimited quota. PGRST202 ("function missing") used to fall
   * back to the old read-then-write, which is exactly the farmable race above;
   * decision 0006 retired that fallback, so it fails loudly instead. Nothing is
   * created, because the claim happens before the work it gates.
   */
  if (error.code === 'PGRST202') throw missingFunctionError('claim_daily_quota', error);
  throw error;
}

module.exports = { claimDailyQuota };
