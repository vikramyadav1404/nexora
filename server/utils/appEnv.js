/**
 * Which deployment this is.
 *
 * NODE_ENV cannot answer this. Vercel sets it to `production` for every
 * deployment it builds, staging included, so a check against it would report
 * staging as production -- the single most dangerous wrong answer available
 * here, because it is the one that makes someone believe a destructive test
 * landed somewhere safe.
 *
 * APP_ENV is separate and explicit for that reason.
 *
 * ------------------------------------------------------------------
 * Which way this fails
 * ------------------------------------------------------------------
 * `production` is returned only for exactly that string. Unset, empty,
 * misspelled, whitespace, wrong case -- everything else is treated as a
 * non-production environment.
 *
 * The asymmetry is deliberate and matches the JWT-secret reasoning: forgetting
 * to configure staging leaves it visibly marked as not-production, which costs
 * nothing. Forgetting on production shows a banner to real users, which is
 * embarrassing, immediately visible, and fixed in minutes. One of those errors
 * ends with someone running a destructive test against live data and the other
 * does not.
 */

const PRODUCTION = 'production';

/** @returns {string} the environment name, never empty. */
function appEnv(env = process.env) {
  const raw = String(env.APP_ENV || '').trim();
  if (!raw) return 'unknown';
  return raw.toLowerCase();
}

/**
 * @returns {boolean} true only for an exact, unambiguous production marker.
 *
 * Note this is not `appEnv() !== 'staging'`. Asking "is it production" and
 * requiring proof is different from asking "is it staging" and assuming
 * production otherwise -- the second treats every misconfiguration as
 * production, which is the wrong default for anything destructive.
 */
function isProduction(env = process.env) {
  return String(env.APP_ENV || '').trim().toLowerCase() === PRODUCTION;
}

module.exports = { appEnv, isProduction, PRODUCTION };
