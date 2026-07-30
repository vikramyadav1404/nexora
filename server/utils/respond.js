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
    // In dev the real error is far more useful than a generic string
    ...(isProd() ? {} : { detail: err?.message })
  });
}

module.exports = { sendError, requestId };
