/**
 * /api/version has to identify the build, or say it cannot.
 *
 * It returned a static '1.0.0' for every deploy ever made, so working out what
 * was in production meant sending a request only the new code answers
 * differently. That guessing went wrong twice in one week: once reporting work
 * as live that had only been pushed to GitHub, and once assuming a deploy had
 * happened when it had not.
 *
 * The subtle requirement is the second half. A deploy that was not stamped must
 * report `commit: null, stamped: false` -- never a placeholder, never a stale
 * value dressed as current. An unknown commit and a known one must not read
 * alike, which is the same distinction the client's empty-vs-failed work turned
 * on: the failure mode of a plausible wrong answer is worse than no answer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const STAMP = path.join(process.cwd(), 'version.generated.json');

/** version.js reads the stamp at module load, so it must be re-required. */
function loadVersion() {
  delete require.cache[require.resolve('../version.js')];
  return require('../version.js');
}

let savedStamp = null;
let savedVercel;

beforeEach(() => {
  savedStamp = fs.existsSync(STAMP) ? fs.readFileSync(STAMP, 'utf8') : null;
  savedVercel = process.env.VERCEL;
});

afterEach(() => {
  if (savedStamp === null) { try { fs.unlinkSync(STAMP); } catch { /* nothing to remove */ } }
  else fs.writeFileSync(STAMP, savedStamp);
  if (savedVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = savedVercel;
  delete process.env.VERCEL_DEPLOYMENT_ID;
});

describe('a stamped build', () => {
  it('reports the commit it was built from', () => {
    fs.writeFileSync(STAMP, JSON.stringify({
      commit: 'a'.repeat(40),
      commitShort: 'aaaaaaa',
      committedAt: '2026-08-21T10:00:00.000Z',
      branch: 'main',
      dirty: false,
      builtAt: '2026-08-21T10:05:00.000Z'
    }));

    const v = loadVersion();

    expect(v.commit).toBe('a'.repeat(40));
    expect(v.commitShort).toBe('aaaaaaa');
    expect(v.branch).toBe('main');
    expect(v.stamped).toBe(true);
    expect(v.dirty).toBe(false);
    expect(v.source).toBe('stamp');
  });

  it('REGRESSION: carries the dirty flag through', () => {
    // A build stamped from an uncommitted tree is identifiable by SHA but not
    // reproducible from it. That has to be visible, not smoothed away.
    fs.writeFileSync(STAMP, JSON.stringify({
      commit: 'b'.repeat(40), commitShort: 'bbbbbbb', dirty: true
    }));

    expect(loadVersion().dirty).toBe(true);
  });
});

describe('an unstamped build', () => {
  it('REGRESSION: reports null rather than inventing a commit', () => {
    try { fs.unlinkSync(STAMP); } catch { /* already absent */ }
    // VERCEL set means the local-git fallback is deliberately skipped, which is
    // what a real serverless deploy looks like: no git binary, read-only disk.
    process.env.VERCEL = '1';

    const v = loadVersion();

    expect(v.commit).toBeNull();
    expect(v.commitShort).toBeNull();
    expect(v.stamped).toBe(false);
    expect(v.dirty).toBeNull();
    // Not '', not 'unknown', not '1.0.0' — nothing that could be mistaken for
    // an identifier.
    expect(v.commit).not.toBe('');
    expect(v.commit).not.toBe('unknown');
  });

  it('REGRESSION: a malformed stamp is refused, not half-trusted', () => {
    fs.writeFileSync(STAMP, '{ this is not json');
    process.env.VERCEL = '1';

    const v = loadVersion();

    expect(v.stamped).toBe(false);
    expect(v.commit).toBeNull();
  });

  it('REGRESSION: a stamp without a usable commit is refused', () => {
    fs.writeFileSync(STAMP, JSON.stringify({ commit: 'abc', builtAt: 'x' }));
    process.env.VERCEL = '1';

    expect(loadVersion().stamped).toBe(false);
  });

  it('still reports the platform deployment id, which cannot be stale', () => {
    try { fs.unlinkSync(STAMP); } catch { /* already absent */ }
    process.env.VERCEL = '1';
    process.env.VERCEL_DEPLOYMENT_ID = 'dpl_TestDeployment123';

    const v = loadVersion();

    // The stamp can be missing; this cannot be wrong. It is the floor on how
    // unidentifiable a deploy is allowed to be.
    expect(v.deploymentId).toBe('dpl_TestDeployment123');
    expect(v.stamped).toBe(false);
  });
});

describe('the payload keeps its existing shape', () => {
  it('still carries name, version and api', () => {
    const v = loadVersion();
    expect(v.name).toBe('Nexora');
    expect(v.version).toBe('1.0.0');
    expect(v.api).toBe('1.0.0');
  });
});
