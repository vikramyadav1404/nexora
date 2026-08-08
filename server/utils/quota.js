const { isToday } = require('../db/helpers');

let warnedMissing = false;

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
 * @param {'question'|'post'} kind
 * @param {number} limit - Infinity for unlimited
 * @returns {Promise<{allowed: boolean, used: number}>}
 */
async function claimDailyQuota(db, { userId, kind, limit, userRow }) {
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
   * PGRST202 is "function not found" -- migration 015 has not been applied to
   * this database yet. Falling back to the old read-then-write keeps the app
   * working rather than 500ing every question and post, at the cost of the race
   * being open until the migration lands. Warned once so it is visible in logs
   * without flooding them.
   *
   * Any other error is a real failure and must not be swallowed into a silent
   * allow -- that would turn a database problem into an unlimited quota.
   */
  if (error.code !== 'PGRST202') throw error;

  if (!warnedMissing) {
    warnedMissing = true;
    console.warn('claim_daily_quota missing (migration 015 not applied) — daily limits are not race-safe');
  }

  return legacyClaim(db, { userId, kind, limit, userRow });
}

/** The pre-015 behaviour, kept only for databases without the function. */
async function legacyClaim(db, { userId, kind, limit, userRow }) {
  const countCol = kind === 'question' ? 'questions_today' : 'posts_today';
  const dateCol = kind === 'question' ? 'last_question_date' : 'last_post_date';

  let used = userRow?.[countCol] || 0;
  if (!isToday(userRow?.[dateCol])) used = 0;

  if (limit !== Infinity && used >= limit) return { allowed: false, used };

  used += 1;
  await db.from('users').update({
    [countCol]: used,
    [dateCol]: new Date().toISOString()
  }).eq('id', userId);

  return { allowed: true, used };
}

module.exports = { claimDailyQuota };
