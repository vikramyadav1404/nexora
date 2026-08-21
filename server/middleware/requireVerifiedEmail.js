/**
 * Require a verified email address for actions where an unverified one causes
 * real harm.
 *
 * Deliberately not applied to login. Locking someone out of their own account
 * teaches them nothing and is the fastest way to turn a security control into
 * something people route around. The flag gates specific actions instead.
 *
 * Three, each with a concrete cost:
 *
 *   POST /api/rewards/transfer  moves economic value between accounts. A
 *                               throwaway address is exactly how you farm and
 *                               drain.
 *   POST /api/reports           feeds the moderation queue, which costs a
 *                               human's attention rather than a machine's.
 *   routes/ai.js                calls Claude Opus per request, billed to the
 *                               operator. The only place on the list where an
 *                               unverified account costs actual money.
 *
 * Not gated, and the reasoning matters as much as the list: posting and asking
 * questions are the product, and the daily quotas already bound abuse; payments,
 * because gating revenue is self-harm; reading anything; and blocking someone,
 * which is self-protective and must work regardless of account state.
 *
 * ------------------------------------------------------------------
 * Ordering
 * ------------------------------------------------------------------
 * Must run AFTER `protect`, which populates req.userRow via select('*') -- so
 * email_verified is already there and this costs no extra query.
 *
 * Unlike requireAdmin it does not re-invoke protect. requireAdmin does, because
 * it is used in place of protect; this is used in addition to it, and running a
 * second user lookup per request would be waste. The cost is that mounting it
 * without protect fails open, so it asserts rather than assumes.
 */

function requireVerifiedEmail(req, res, next) {
  /*
   * If protect did not run, req.userRow is absent and there is nothing to
   * check. Failing closed with a 500 is right: a permission middleware that
   * silently passes everything because it was mounted wrong is worse than one
   * that breaks loudly during development.
   */
  if (!req.userRow) {
    console.error('requireVerifiedEmail mounted without protect — no req.userRow');
    return res.status(500).json({ message: 'Server auth misconfigured' });
  }

  if (req.userRow.email_verified === true) return next();

  /*
   * emailVerificationRequired is a flag the client can branch on, so it can
   * offer "resend verification" rather than a dead end.
   *
   * "You cannot do this yet" and "this failed" are different facts and must not
   * render the same -- the same distinction the empty-vs-failed work in the
   * client turned on. A bare 403 with prose is exactly the collapse that causes.
   */
  return res.status(403).json({
    message: 'Verify your email address to use this',
    emailVerificationRequired: true
  });
}

module.exports = { requireVerifiedEmail };
