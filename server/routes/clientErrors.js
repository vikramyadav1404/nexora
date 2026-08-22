const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { writeLimiter } = require('../middleware/rateLimit');
const { reportError } = require('../utils/observability');
const { verifyAccessToken, bearerToken } = require('../middleware/auth');

/**
 * Where a crashed browser reports what happened.
 *
 * The error boundary used to call console.error and stop. That puts the only
 * copy of a production stack trace inside the affected user's devtools, which
 * the operator cannot read -- so a page that threw on every render for everyone
 * was invisible until somebody happened to mention it.
 *
 * This is deliberately not a general logging endpoint. It takes one shape, caps
 * every field, and exists so a render crash reaches somewhere greppable.
 *
 * ------------------------------------------------------------------
 * Not authenticated, on purpose
 * ------------------------------------------------------------------
 * The boundary wraps the whole app including Landing and Login, and a crash on
 * a logged-out page is exactly as worth knowing about. Requiring a session
 * would silently drop that entire class.
 *
 * The trade is that anyone can post here, so: writeLimiter, hard caps on every
 * string, and nothing from the payload is ever interpolated anywhere that
 * executes. The user id is read from the token when one is present rather than
 * taken from the body -- a self-reported identity in an error report is worth
 * less than none, because it looks authoritative.
 */

const LIMITS = {
  message: 500,
  stack: 4000,
  componentStack: 2000,
  route: 200,
  commit: 40
};

/** Truncate rather than reject: a too-long stack is still worth having. */
function clamp(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}… [truncated]` : trimmed;
}

router.post('/', writeLimiter, (req, res) => {
  const body = req.body || {};

  const message = clamp(body.message, LIMITS.message);
  if (!message) {
    return res.status(400).json({ message: 'message is required' });
  }

  /*
   * The reference is what makes a user's report actionable: they read it off
   * the screen, and it greps straight to this line. Without it the operator
   * gets "it broke earlier" and a log full of similar stacks.
   */
  const reference = crypto.randomBytes(4).toString('hex');

  const auth = verifyAccessToken(bearerToken(req));
  const userId = auth.ok ? auth.decoded.id : null;

  const detail = {
    reference,
    message,
    route: clamp(body.route, LIMITS.route),
    commit: clamp(body.commit, LIMITS.commit),
    userId,
    userAgent: clamp(req.headers['user-agent'] || '', 200),
    stack: clamp(body.stack, LIMITS.stack),
    componentStack: clamp(body.componentStack, LIMITS.componentStack)
  };

  /*
   * console.error, not just reportError. reportError returns immediately when
   * SENTRY_DSN is unset -- which it is here -- so relying on it alone would
   * have reproduced the original problem one layer further back: a reporting
   * path that silently discards everything.
   *
   * stdout is what reaches `vercel logs`, so this is the copy the operator can
   * actually read today.
   */
  console.error('[client-error]', JSON.stringify(detail));

  const err = new Error(message);
  err.stack = detail.stack || err.stack;
  reportError(err, { requestId: reference, route: detail.route, userId }).catch(() => {});

  // 202: recorded, nothing for the caller to do. The browser is already broken;
  // it must not be given anything else to handle.
  return res.status(202).json({ reference });
});

module.exports = router;
