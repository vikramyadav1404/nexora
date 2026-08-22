/**
 * The guard that stands between the seeder and a production database.
 *
 * The seeder creates and overwrites accounts. Pointed at the wrong project it
 * is a data-destruction tool, so these tests are about one question: can it be
 * talked into running somewhere real?
 *
 * The interesting assertions are the data-derived ones. Every config check
 * describes intent, and intent is precisely what is wrong when somebody runs
 * the wrong command -- so the check that actually protects production asks the
 * database what it contains rather than asking the operator what they meant.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isSyntheticEmail, inspectTarget, configObjections
} = require('../utils/seedGuard.js');

/** A stand-in for the PostgREST client, so the failure paths are reachable. */
function fakeDb(rows, error = null) {
  return {
    from: () => ({
      select: () => ({
        limit: () => Promise.resolve({ data: rows, error })
      })
    })
  };
}

describe('what counts as synthetic', () => {
  it('accepts the reserved and seed domains', () => {
    // .invalid is RFC 2606 reserved and can never resolve, so a synthetic
    // account cannot receive mail even if something tries to send it.
    expect(isSyntheticEmail('someone@nexora.invalid')).toBe(true);
    expect(isSyntheticEmail('creator.technology@nexora.seed')).toBe(true);
    expect(isSyntheticEmail('SOMEONE@NEXORA.INVALID')).toBe(true);
  });

  it('REGRESSION: a real address is not synthetic', () => {
    for (const email of [
      'vikramyadav6704@gmail.com',
      'someone@example.com',
      '',
      null,
      undefined,
      'nexora.invalid@gmail.com'   // the suffix appears, but not at the end
    ]) {
      expect(isSyntheticEmail(email), `${JSON.stringify(email)} must not read as synthetic`).toBe(false);
    }
  });

  it('REGRESSION: a domain that merely CONTAINS the suffix is not synthetic', () => {
    /*
     * Added because the mutation endsWith -> includes survived the case above.
     * 'nexora.invalid@gmail.com' does not contain '@nexora.invalid', so it
     * proved nothing about which matcher was in use.
     *
     * These do contain it, mid-string. A substring match would classify them
     * synthetic -- and since anyone can register an address at a domain they
     * control, that would let a database holding real accounts pass the guard
     * that exists to stop exactly that.
     */
    expect(isSyntheticEmail('attacker@nexora.invalid.evil.com')).toBe(false);
    expect(isSyntheticEmail('someone@nexora.seed.example.org')).toBe(false);
    expect(isSyntheticEmail('a@nexora.test.co')).toBe(false);
  });
});

describe('inspecting the target database', () => {
  it('a database of only synthetic accounts is safe', async () => {
    const result = await inspectTarget(fakeDb([
      { email: 'a@nexora.invalid' },
      { email: 'creator.sports@nexora.seed' }
    ]));

    expect(result.safe).toBe(true);
    expect(result.real).toBe(0);
  });

  it('an empty database is safe', async () => {
    expect((await inspectTarget(fakeDb([]))).safe).toBe(true);
  });

  it('REGRESSION: one real account makes it unsafe', async () => {
    /*
     * The check that actually protects production. Twenty-nine synthetic rows
     * and one real person is still a database with a real person in it.
     */
    const rows = Array.from({ length: 29 }, (_, i) => ({ email: `u${i}@nexora.invalid` }));
    rows.push({ email: 'vikramyadav6704@gmail.com' });

    const result = await inspectTarget(fakeDb(rows));

    expect(result.safe).toBe(false);
    expect(result.real).toBe(1);
  });

  it('REGRESSION: a failed read refuses rather than assuming empty', async () => {
    /*
     * The exact mistake the nightly sweep made twice -- "I could not read the
     * data" treated as "there is no data". Here that reasoning would conclude
     * an unreadable production database is an empty staging one, which is the
     * worst possible wrong answer.
     */
    await expect(
      inspectTarget(fakeDb(null, { message: 'statement timeout' }))
    ).rejects.toThrow(/refusing|cannot verify/i);
  });

  it('redacts the examples it reports', async () => {
    // Enough to recognise the database, not enough to be a contact list. An
    // abort message is still a place a real address could leak.
    const result = await inspectTarget(fakeDb([{ email: 'vikramyadav6704@gmail.com' }]));

    expect(result.examples[0]).not.toContain('vikramyadav6704');
    expect(result.examples[0]).toContain('gmail.com');
  });
});

describe('the config checks', () => {
  const ok = {
    appEnv: 'staging',
    supabaseUrl: 'https://abcdefghij.supabase.co',
    confirmRef: 'abcdefghij'
  };

  it('passes when everything lines up', () => {
    expect(configObjections(ok)).toEqual([]);
  });

  it('REGRESSION: refuses unless APP_ENV is exactly staging', () => {
    for (const appEnv of [undefined, '', 'production', 'stage', 'STAGING ']) {
      const problems = configObjections({ ...ok, appEnv });
      if (String(appEnv || '').trim().toLowerCase() === 'staging') continue;
      expect(problems.length, `APP_ENV=${JSON.stringify(appEnv)} should be refused`).toBeGreaterThan(0);
    }
  });

  it('REGRESSION: refuses when --confirm names a different project', () => {
    // The case this catches: the right intent, the wrong .env loaded.
    const problems = configObjections({ ...ok, confirmRef: 'someotherref' });
    expect(problems.join(' ')).toMatch(/not the project you named/i);
  });

  it('REGRESSION: requires --confirm at all', () => {
    const problems = configObjections({ ...ok, confirmRef: undefined });
    expect(problems.join(' ')).toMatch(/--confirm/);
  });
});
