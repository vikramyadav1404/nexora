/**
 * The production cost factors, pinned.
 *
 * The rest of the suite runs bcrypt at cost 4 (BCRYPT_TEST_COST in
 * vitest.config.js), because bcrypt was 74% of the suite -- 32.6s of 43.8s,
 * measured over ten runs -- and none of the behaviour under test depends on the
 * factor. A wrong password is rejected at any cost; a backup code works once at
 * any cost.
 *
 * That knob is also exactly the kind of thing that silently ruins a system: set
 * it in the wrong place and every password in the database is weakly hashed,
 * with nothing failing and no error to notice. So this file is the other half
 * of the trade -- it asserts the real values and that the override cannot reach
 * them outside tests.
 *
 * If someone removes either half of the guard in utils/bcryptCost.js, these go
 * red. That is the point; they are not a formality.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  passwordCost, backupCodeCost, fixtureCost,
  PASSWORD_COST, BACKUP_CODE_COST, FIXTURE_COST
} = require('../utils/bcryptCost.js');

const saved = { NODE_ENV: process.env.NODE_ENV, BCRYPT_TEST_COST: process.env.BCRYPT_TEST_COST };

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('the production factors', () => {
  it('REGRESSION: passwords are cost 12 in production, whatever the override says', () => {
    process.env.NODE_ENV = 'production';
    process.env.BCRYPT_TEST_COST = '4';

    expect(passwordCost()).toBe(12);
    expect(PASSWORD_COST).toBe(12);
  });

  it('REGRESSION: backup codes are cost 10 in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.BCRYPT_TEST_COST = '4';

    expect(backupCodeCost()).toBe(10);
    expect(BACKUP_CODE_COST).toBe(10);
  });

  it('REGRESSION: fixtures are cost 10 in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.BCRYPT_TEST_COST = '4';

    expect(fixtureCost()).toBe(10);
    expect(FIXTURE_COST).toBe(10);
  });

  it('REGRESSION: development ignores the override too', () => {
    // Only NODE_ENV === 'test' opens the door. Development is not test.
    process.env.NODE_ENV = 'development';
    process.env.BCRYPT_TEST_COST = '4';

    expect(passwordCost()).toBe(12);
  });

  it('REGRESSION: an unset NODE_ENV fails closed', () => {
    // A missing value must not read as "probably a test". Same positive-test
    // reasoning as isDev() in utils/respond.js.
    delete process.env.NODE_ENV;
    process.env.BCRYPT_TEST_COST = '4';

    expect(passwordCost()).toBe(12);
  });
});

describe('the override, where it is allowed', () => {
  it('applies only when both conditions hold', () => {
    process.env.NODE_ENV = 'test';
    process.env.BCRYPT_TEST_COST = '4';
    expect(passwordCost()).toBe(4);

    // Either half missing, and it is off.
    delete process.env.BCRYPT_TEST_COST;
    expect(passwordCost()).toBe(12);
  });

  it('REGRESSION: a nonsense value falls back rather than becoming 0', () => {
    process.env.NODE_ENV = 'test';

    for (const bad of ['0', '-1', 'abc', '3', '32', '', '4.5']) {
      process.env.BCRYPT_TEST_COST = bad;
      expect(passwordCost()).toBe(12);
    }
  });

  it('accepts the valid bcrypt range', () => {
    process.env.NODE_ENV = 'test';
    for (const good of ['4', '10', '31']) {
      process.env.BCRYPT_TEST_COST = good;
      expect(passwordCost()).toBe(Number(good));
    }
  });
});

describe('the factors are actually used', () => {
  /*
   * A cost module nothing calls would pass every test above and change nothing.
   * These assert the wiring: hashPassword must produce a hash whose embedded
   * cost matches. bcrypt encodes it in the prefix, $2a$NN$, so it is readable
   * straight off the output.
   */
  const bcrypt = require('bcryptjs');
  const { hashPassword } = require('../db/helpers.js');

  const costOf = (hash) => Number(hash.split('$')[2]);

  it('REGRESSION: hashPassword honours the configured cost', async () => {
    process.env.NODE_ENV = 'test';
    process.env.BCRYPT_TEST_COST = '4';

    expect(costOf(await hashPassword('whatever'))).toBe(4);
  });

  it('REGRESSION: hashPassword uses cost 12 when the override does not apply', async () => {
    process.env.NODE_ENV = 'production';

    const hash = await hashPassword('whatever');

    expect(costOf(hash)).toBe(12);
    // And the hash is still a real, verifiable one.
    expect(await bcrypt.compare('whatever', hash)).toBe(true);
  }); // pays real cost 12 (~400ms); well inside the 15s global timeout
});
