import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The server is CommonJS; run tests in Node with globals off so each file
    // imports what it needs explicitly.
    environment: 'node',
    // .mjs so the test files are ESM (vitest can't be require()d) while the
    // server source stays CommonJS.
    include: ['test/**/*.test.mjs'],
    // Route modules read process.env at require time, and several tests mutate
    // it — isolate so one file's env can't leak into another's.
    isolate: true,
    pool: 'forks',

    /*
     * bcrypt was 74% of this suite -- 32.6s of 43.8s, measured over ten runs,
     * concentrated in mfa (48%), envLeaks (16%) and authTokens (10%). On this
     * machine cost 12 is ~404ms a hash and cost 10 is ~104ms, against ~3ms at
     * cost 4.
     *
     * None of the behaviour under test depends on the factor: a wrong password
     * is rejected, a backup code works once, a reset does not leak the new
     * password -- all true at any cost. utils/bcryptCost.js honours this only
     * when NODE_ENV is exactly 'test', and a test pins the production values
     * with NODE_ENV=production so this cannot quietly weaken real hashing.
     */
    env: {
      NODE_ENV: 'test',
      BCRYPT_TEST_COST: '4'
    },

    /*
     * 15s, derived rather than picked.
     *
     * Measured over ten full runs after the cost change: the slowest single
     * test has a p95 of 1394ms and a max of 1394ms. The flake that prompted
     * this took 6837ms when that same test's p95 was 1226ms -- a 5.6x spike,
     * caused by external load that ten clean runs cannot reproduce. So the
     * headroom has to cover more than the observed tail, not just clear it:
     * 15s is ~10.8x the worst p95, comfortably past that spike ratio.
     *
     * Note the slowest test is the one that deletes NODE_ENV to check for
     * environment leaks. Doing so switches bcrypt back to cost 12 -- correctly,
     * that is the guard working -- so it pays ~400ms a hash on purpose. It is
     * the one place in the suite where the real factor is the thing under test.
     *
     * Suite went from 43.8s of test time to ~21s, 7.5s wall.
     */
    testTimeout: 15000
  }
});
