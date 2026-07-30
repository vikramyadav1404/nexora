/**
 * Request logging and error reporting.
 *
 * Before this the server had 67 bare console.log/error calls with no request
 * correlation, and no error reporting at all — a 500 in production was
 * invisible unless someone happened to be reading Vercel's log stream.
 *
 * Two pieces:
 *   1. requestLogger — one structured JSON line per request, with a request id
 *      that sendError() reuses, so a user's error report can be traced.
 *   2. reportError    — ships exceptions to Sentry when SENTRY_DSN is set.
 *
 * Sentry is entirely optional: with no DSN this degrades to console logging and
 * costs nothing. It is wired via raw HTTP rather than @sentry/node so the
 * serverless bundle stays small and there is no dependency to keep current.
 */
const { requestId } = require('./respond');

const isProd = () => process.env.NODE_ENV === 'production';

/** Paths that would otherwise flood the log with no information. */
const QUIET = new Set(['/api/health', '/api/ready', '/api/cron/keepalive']);

/**
 * Structured access log.
 *
 * JSON so Vercel's log search can filter on fields. Slow requests are tagged
 * so they can be found without reading every line.
 */
function requestLogger(req, res, next) {
  const started = Date.now();
  const id = requestId(req);
  res.setHeader('X-Request-Id', id);

  res.on('finish', () => {
    if (QUIET.has(req.path) && res.statusCode < 400) return;

    const ms = Date.now() - started;
    const line = {
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      requestId: id,
      method: req.method,
      path: req.route ? req.baseUrl + req.route.path : req.path,
      status: res.statusCode,
      ms,
      userId: req.user?.id || null
    };
    // Anything over a second on this app is worth a look.
    if (ms > 1000) line.slow = true;

    console.log(JSON.stringify(line));
  });

  next();
}

/**
 * Send an exception to Sentry.
 *
 * Fire-and-forget: a monitoring outage must never turn into a user-facing
 * failure, so every error path here is swallowed.
 */
async function reportError(err, context = {}) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  try {
    // DSN format: https://<key>@<host>/<projectId>
    const parsed = new URL(dsn);
    const projectId = parsed.pathname.replace('/', '');
    const endpoint = `${parsed.protocol}//${parsed.host}/api/${projectId}/store/`;

    const body = {
      event_id: (context.requestId || '').replace(/-/g, '').slice(0, 32) || undefined,
      timestamp: new Date().toISOString(),
      platform: 'node',
      level: 'error',
      logger: 'nexora-api',
      environment: process.env.NODE_ENV || 'development',
      release: require('../version').version,
      server_name: 'vercel',
      exception: {
        values: [{
          type: err?.name || 'Error',
          value: err?.message || String(err),
          stacktrace: { frames: parseStack(err?.stack) }
        }]
      },
      tags: { path: context.path, method: context.method },
      user: context.userId ? { id: context.userId } : undefined,
      extra: { requestId: context.requestId }
    };

    await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth':
          `Sentry sentry_version=7, sentry_client=nexora/1.0, sentry_key=${parsed.username}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000)
    });
  } catch {
    /* monitoring must never break the request */
  }
}

/** Sentry wants oldest frame first. */
function parseStack(stack) {
  if (!stack) return [];
  return String(stack)
    .split('\n')
    .slice(1, 21)
    .map((line) => {
      const m = line.match(/at (?:(.+?) )?\(?(.+?):(\d+):(\d+)\)?$/);
      if (!m) return null;
      return {
        function: m[1] || '<anonymous>',
        filename: m[2],
        lineno: Number(m[3]),
        colno: Number(m[4]),
        in_app: !m[2].includes('node_modules')
      };
    })
    .filter(Boolean)
    .reverse();
}

/** True when error reporting is actually configured. */
function isMonitoringEnabled() {
  return !!process.env.SENTRY_DSN;
}

module.exports = { requestLogger, reportError, isMonitoringEnabled };
