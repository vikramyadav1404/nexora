const { computeBadges } = require('../db/helpers');

let warnedMissing = false;

/**
 * Move a user's points and upvote counter by a delta, atomically.
 *
 * The answer-vote handler used to read the author row, adjust `points` in
 * JavaScript across several awaits, and write the absolute value back --
 * unconditionally, even when nothing had changed. Any concurrent change was
 * reverted: an author who posted an answer (+5) while somebody upvoted an older
 * one lost the award, because the vote handler wrote back the balance it had
 * read before it.
 *
 * apply_vote_points (migration 016) takes a row lock, applies the deltas to
 * whatever the row currently holds, floors both counters at zero and recomputes
 * badges -- all in one statement, so there is nothing to carry across an await.
 *
 * @returns {Promise<{points: number, totalUpvotes: number, badges: string[]}>}
 */
async function applyVotePoints(db, userId, pointsDelta, upvotesDelta) {
  const { data, error } = await db.rpc('apply_vote_points', {
    p_user_id: userId,
    p_points_delta: pointsDelta,
    p_upvotes_delta: upvotesDelta
  });

  if (!error) {
    const row = Array.isArray(data) ? data[0] : data;
    return {
      points: row?.points ?? 0,
      totalUpvotes: row?.total_upvotes_received ?? 0,
      badges: row?.badges || []
    };
  }

  /*
   * PGRST202 means migration 016 has not been applied. Fall back to the old
   * read-modify-write so voting keeps working, warned once. Any other error is
   * a real failure and must surface -- swallowing it would leave the vote row
   * written and the author's points silently unchanged, which is the
   * inconsistency this function exists to prevent.
   */
  if (error.code !== 'PGRST202') throw error;

  if (!warnedMissing) {
    warnedMissing = true;
    console.warn('apply_vote_points missing (migration 016 not applied) — vote points are not race-safe');
  }

  return legacyApply(db, userId, pointsDelta, upvotesDelta);
}

/** Pre-016 behaviour, kept only for databases without the function. */
async function legacyApply(db, userId, pointsDelta, upvotesDelta) {
  const { data: user, error } = await db
    .from('users')
    .select('points, total_upvotes_received, total_answers')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  if (!user) return { points: 0, totalUpvotes: 0, badges: [] };

  const points = Math.max(0, (user.points || 0) + pointsDelta);
  const totalUpvotes = Math.max(0, (user.total_upvotes_received || 0) + upvotesDelta);
  const badges = computeBadges(points, user.total_answers || 0);

  // The error is checked here, unlike the write this replaced: a failed points
  // update used to be discarded, leaving the vote recorded and the balance not.
  const { error: writeErr } = await db
    .from('users')
    .update({ points, total_upvotes_received: totalUpvotes, badges })
    .eq('id', userId);

  if (writeErr) throw writeErr;
  return { points, totalUpvotes, badges };
}

module.exports = { applyVotePoints };
