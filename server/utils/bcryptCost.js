/**
 * The single place a bcrypt cost factor is chosen.
 *
 * It was chosen in seven: db/helpers.js (12), utils/mfa.js (10), and five
 * fixture sites in demoStore, seedInterests, verifySchema and routes/demo.js
 * (10 each). Seven literals with no shared name meant no way to reason about
 * them together and no way to change them together.
 *
 * ------------------------------------------------------------------
 * Why this exists now: the test suite was 74% bcrypt
 * ------------------------------------------------------------------
 * Measured over ten full runs: 32.6s of 43.8s total test time was spent inside
 * bcrypt, concentrated in three files (mfa 48%, envLeaks 16%, authTokens 10%).
 * On this machine cost 12 is ~404ms per hash and cost 10 is ~104ms, against
 * ~3ms at cost 4.
 *
 * None of the logic those tests cover depends on the factor. They test that a
 * wrong password is rejected, that a backup code works once, that a reset does
 * not leak the new password -- all true at any cost. Paying 400ms a hash to
 * prove them is waste, and it produced a real cost: a test timed out at 6837ms
 * during a run, which is 5.6x its own measured p95. Raising the timeout would
 * have accommodated the waste rather than removed it.
 *
 * ------------------------------------------------------------------
 * Why the override is gated twice
 * ------------------------------------------------------------------
 * A cheap knob on password hashing is a liability: set it in the wrong
 * environment and every password in the database is weakly hashed, silently,
 * with nothing failing. So it requires BOTH that NODE_ENV is exactly 'test' AND
 * that BCRYPT_TEST_COST is set. Neither alone does anything.
 *
 * The production values are asserted by a test that runs with NODE_ENV set to
 * production, so removing either half of the guard turns it red.
 */

const PASSWORD_COST = 12;
const BACKUP_CODE_COST = 10;
const FIXTURE_COST = 10;

/**
 * Both conditions, deliberately. NODE_ENV is compared to the exact string
 * rather than checked for absence, so an unset or misspelled value fails
 * closed -- the same positive-test reasoning as isDev() in utils/respond.js.
 */
function testOverride() {
  if (process.env.NODE_ENV !== 'test') return null;
  const raw = process.env.BCRYPT_TEST_COST;
  if (!raw) return null;

  const cost = Number(raw);
  // bcrypt's own valid range. A nonsense value must not silently become 0.
  if (!Number.isInteger(cost) || cost < 4 || cost > 31) return null;
  return cost;
}

/** Real user credentials. The one that actually protects an account. */
function passwordCost() {
  return testOverride() ?? PASSWORD_COST;
}

/**
 * MFA backup codes.
 *
 * Lower than passwords on purpose, and the reasoning is recorded in
 * utils/mfa.js: these carry ~49 bits of CSPRNG entropy, so there is no
 * low-entropy guess space for a slow KDF to defend, and ten of them are
 * generated at once.
 */
function backupCodeCost() {
  return testOverride() ?? BACKUP_CODE_COST;
}

/**
 * Seed and demo data. Never a real user's credential -- these hash known
 * literals like 'demo1234' that are published in the README.
 */
function fixtureCost() {
  return testOverride() ?? FIXTURE_COST;
}

module.exports = {
  passwordCost,
  backupCodeCost,
  fixtureCost,
  // Exported for the test that pins them; not for use as call-site constants.
  PASSWORD_COST,
  BACKUP_CODE_COST,
  FIXTURE_COST
};
