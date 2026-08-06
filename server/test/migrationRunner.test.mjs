/**
 * The migration runner generator.
 *
 * This exists because of what it replaced. Four hand-maintained files
 * (SETUP_ALL.sql and three RUN_*.sql) held concatenated copies of the numbered
 * migrations, 1,808 lines of them. Nothing kept the copies in step with the
 * originals, and by the time they were deleted SETUP_ALL.sql had fallen three
 * migrations behind: a database built from it had no refresh_tokens table and no
 * MFA columns, so sessions expired after fifteen minutes and two-factor could
 * not be turned on. The setup path the README recommended was broken and silent.
 *
 * Generating the file removes the copies. These tests cover the two properties
 * that made the old approach fail: that the fresh-install set really is
 * complete, and that concatenation cannot corrupt a function body.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runner = require('../scripts/build-migration-runner.js');

describe('migration selection', () => {
  it('finds every numbered migration in order', () => {
    const all = runner.allMigrations();
    expect(all.length).toBeGreaterThanOrEqual(11);
    expect(all[0]).toMatch(/^000_/);
    expect([...all]).toEqual([...all].sort()); // lexical sort == apply order
  });

  it('a fresh install skips 000, which 001 supersedes', () => {
    // 001 declares all of 000's users columns plus three more, and creates
    // notifications, bookmarks, blocks and reports on top. Running 000 first
    // would be harmless but redundant.
    const fresh = runner.freshInstall();
    expect(fresh.some((f) => f.startsWith('000_'))).toBe(false);
    expect(fresh.some((f) => f.startsWith('001_'))).toBe(true);
  });

  it('REGRESSION: a fresh install includes the newest migrations', () => {
    // The exact failure of the old SETUP_ALL.sql: it stopped at 007, so a new
    // database had no session table and no MFA. Anything appended to the folder
    // must be picked up automatically.
    const sql = runner.build(runner.freshInstall());
    expect(sql).toContain('refresh_tokens');   // 009
    expect(sql).toContain('mfa_backup_codes'); // 010
    expect(sql).toContain('mfa_enabled');      // 010

    const newest = runner.allMigrations().at(-1);
    expect(runner.freshInstall()).toContain(newest);
  });

  it('accepts a number, a padded number, or a filename', () => {
    const all = runner.allMigrations();
    const full = runner.resolve('005', all);
    expect(runner.resolve('5', all)).toBe(full);
    expect(runner.resolve(full, all)).toBe(full);
  });

  it('refuses a migration that does not exist', () => {
    expect(() => runner.resolve('999', runner.allMigrations())).toThrow(/No migration matches/);
  });
});

describe('generated SQL', () => {
  it('keeps dollar-quoted function bodies balanced', () => {
    // An odd count means a plpgsql body was split, and Postgres would report a
    // syntax error far from the real cause.
    const sql = runner.build(runner.freshInstall());
    const markers = (sql.match(/\$\$/g) || []).length;
    expect(markers % 2).toBe(0);
    expect(markers).toBeGreaterThan(0);
  });

  it('includes each requested migration exactly once, in order', () => {
    const sql = runner.build(['005_hardening.sql', '006_feed.sql', '007_search.sql']);
    expect(sql.indexOf('005_hardening.sql')).toBeLessThan(sql.indexOf('006_feed.sql'));
    expect(sql.indexOf('006_feed.sql')).toBeLessThan(sql.indexOf('007_search.sql'));
    expect(sql.match(/-- 006_feed\.sql/g)).toHaveLength(1);
  });

  it('says it is generated, so nobody edits the output by hand', () => {
    const sql = runner.build(['010_mfa.sql']);
    expect(sql).toMatch(/GENERATED FILE/);
    expect(sql).toMatch(/do not commit/i);
  });

  it('derives the verification query from the migrations being run', () => {
    const check = runner.verificationQuery(['009_auth_tokens.sql', '008_profile_media.sql']);
    expect(check).toContain("to_regclass('public.refresh_tokens')");
    expect(check).toContain("('users','avatar_key')");
    // The expected count is in the alias, so a mismatch is visible in the result.
    expect(check).toMatch(/columns_found_expected_\d+/);
  });

  it('omits the verification block when there is nothing to check', () => {
    expect(runner.verificationQuery([])).toBe('');
  });
});
