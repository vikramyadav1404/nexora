const crypto = require('crypto');

/**
 * Shared error responder.
 *
 * Nearly every route used to end in:
 *   catch (err) { res.status(500).json({ message: err.message }) }
 *
 * which sent the raw Postgres/PostgREST error string to the browser — leaking
 * table and column names — while usually logging nothing server-side. So a 500
 * was simultaneously over-informative to a caller and invisible to us.
 *
 * Now: the full error is logged with a request id, and the client gets a short
 * message plus that id to quote in a bug report.
 */

const isProd = () => process.env.NODE_ENV === 'production';

/**
 * Whether it is safe to put development aids in a response body.
 *
 * Deliberately a positive test for 'development' rather than `!== 'production'`.
 * The negated form fails open: an unset, empty, or misspelled NODE_ENV — a
 * missing dashboard variable, a typo, a process started outside the usual
 * wrapper — silently satisfies it, and the endpoint starts handing plaintext
 * passwords, OTPs and stack traces to unauthenticated callers.
 *
 * With this form, anything other than an explicit 'development' reveals
 * nothing. The worst case is a developer losing a convenience, rather than a
 * production deployment leaking credentials.
 */
const isDev = () => process.env.NODE_ENV === 'development';

/** Errors we deliberately surface verbatim — they tell the operator how to fix setup. */
function isSafeSetupError(err) {
  const msg = String(err?.message || '');
  return (
    err?.code === 'PGRST204' ||
    /Database schema incomplete/i.test(msg) ||
    /Run server\/db\/migrations/i.test(msg) ||
    /Missing SUPABASE_URL/i.test(msg) ||
    /still look like placeholders/i.test(msg)
  );
}

function requestId(req) {
  if (!req) return crypto.randomUUID();
  if (!req._nexoraRequestId) {
    req._nexoraRequestId =
      req.headers?.['x-request-id'] ||
      req.headers?.['x-vercel-id'] ||
      crypto.randomUUID();
  }
  return req._nexoraRequestId;
}

/**
 * @param {import('express').Response} res
 * @param {Error} err
 * @param {import('express').Request} [req]
 * @param {string} [message] Client-facing summary. Keep it human and non-specific.
 * @param {number} [status]
 */
function sendError(res, err, req, message = 'Something went wrong on our end', status = 500) {
  const id = requestId(req);
  const context = {
    requestId: id,
    method: req?.method,
    path: req?.originalUrl || req?.url,
    userId: req?.user?.id || null
  };

  console.error(
    JSON.stringify({
      level: 'error',
      ...context,
      code: err?.code,
      message: err?.message,
      stack: isProd() ? undefined : err?.stack
    })
  );

  // Ship to Sentry when SENTRY_DSN is configured. Required lazily to avoid a
  // circular import — observability.js depends on this module for requestId.
  // Deliberately not awaited: monitoring must not add latency to a response
  // that is already an error.
  if (status >= 500) {
    try {
      require('./observability').reportError(err, context);
    } catch { /* never let monitoring break the response */ }
  }

  if (res.headersSent) return;

  // Schema/config problems are actionable, so keep them readable.
  if (isSafeSetupError(err)) {
    return res.status(503).json({ message: err.message, requestId: id });
  }

  res.status(status).json({
    message,
    requestId: id,
    // In dev the real error is far more useful than a generic string.
    // isDev(), not !isProd(): an unset NODE_ENV must not start echoing raw
    // Postgres errors — table and column names included — back to callers.
    ...(isDev() ? { detail: err?.message } : {})
  });
}

/**
 * Wrap an async route handler so a rejected promise lands in sendError.
 *
 * Almost every handler ended in the same two lines:
 *
 *   try {
 *     ...
 *   } catch (err) { sendError(res, err, req, 'Could not load the thing'); }
 *
 * The message is worth keeping — "Could not load your two-factor status" is more
 * use to someone than a generic string — so it moves here as the second
 * argument rather than being dropped into one catch-all middleware.
 *
 *   router.get('/x', protect, asyncHandler(async (req, res) => {
 *     ...
 *   }, 'Could not load the thing'));
 *
 * `next` is still passed through, so a handler that wants Express's own error
 * path can call it. Anything thrown or rejected is routed to sendError with the
 * same arguments the hand-written catch used, so responses do not change.
 */
function asyncHandler(handler, message) {
  return function wrapped(req, res, next) {
    /*
     * The try is not redundant.
     *
     * Promise.resolve(...).catch() only sees a rejection. A handler that throws
     * *synchronously* — before it ever returns a promise — throws straight out
     * of this function, past the .catch, into Express's default error handler,
     * which answers with an HTML error page instead of the JSON contract every
     * caller expects. Every handler converted so far is `async` and so cannot
     * do that, but the next one added might not be, and the failure would look
     * like the endpoint returning HTML for no reason.
     */
    try {
      Promise.resolve(handler(req, res, next)).catch((err) => sendError(res, err, req, message));
    } catch (err) {
      sendError(res, err, req, message);
    }
  };
}

module.exports = { isDev, sendError, requestId, asyncHandler };
