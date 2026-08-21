/**
 * Which origins may make credentialed cross-origin requests.
 *
 * Extracted from index.js so it can be tested: requiring index.js starts a
 * server and mounts every route, which is why the demo-mode decision was moved
 * out for the same reason. A security rule nothing can exercise is a security
 * rule nobody checks.
 *
 * The rule this replaces allowed any origin matching /\.vercel\.app$/i with
 * `credentials: true`. Anyone can deploy to attacker-xyz.vercel.app, so that let
 * an arbitrary site read authenticated responses. Confirmed against production
 * before changing it: an unrelated .vercel.app origin came back echoed in
 * Access-Control-Allow-Origin.
 */

const LOCALHOST = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/** CLIENT_URL plus the explicit CORS_EXTRA_ORIGINS escape hatch. */
function allowedOrigins(env = process.env) {
  return [
    ...(env.CLIENT_URL || 'http://localhost:5173').split(','),
    ...(env.CORS_EXTRA_ORIGINS || '').split(',')
  ].map(s => s.trim()).filter(Boolean);
}

/**
 * @returns {boolean} whether `origin` may send credentials to this API.
 */
function isAllowedOrigin(origin, env = process.env) {
  // No Origin header at all: same-origin, curl, server-to-server. Not CORS.
  if (!origin) return true;

  const allowed = allowedOrigins(env);
  if (allowed.includes(origin) || allowed.includes('*')) return true;

  /*
   * localhost is development-only. It was previously matched in production
   * too, where no legitimate localhost origin exists -- and note the anchored
   * pattern: `localhost.evil.com` must not match.
   */
  if (env.NODE_ENV !== 'production' && LOCALHOST.test(origin)) return true;

  return false;
}

module.exports = { isAllowedOrigin, allowedOrigins, LOCALHOST };
