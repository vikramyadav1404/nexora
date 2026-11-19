const { missingFunctionError } = require('./raceFunctions');

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
   * Every error surfaces, PGRST202 ("function missing") included. The old
   * read-modify-write fallback for PGRST202 is gone -- decision 0006 -- because
   * it was the very race this function exists to close. Swallowing any error
   * here would leave the vote row written and the author's points silently
   * unchanged.
   */
  if (error.code === 'PGRST202') throw missingFunctionError('apply_vote_points', error);
  throw error;
}

module.exports = { applyVotePoints };
