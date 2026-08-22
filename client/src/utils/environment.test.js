/**
 * Which environment the page thinks it is in.
 *
 * The failure this prevents is specific: a staging environment that looks like
 * production, which is how a destructive test eventually lands on real data.
 *
 * So the asymmetry is the thing under test. Every ambiguous input must resolve
 * to "not production", and only an exact, unambiguous marker on both halves may
 * resolve to production. A test suite that only checked the happy path would
 * pass against an implementation that defaults to production, which is the one
 * behaviour that must never ship.
 */
import { describe, it, expect } from 'vitest';
import { classifyEnvironment, isProductionValue, normalise } from './environment.js';

describe('what counts as production', () => {
  it('accepts the exact marker, case and whitespace insensitively', () => {
    expect(isProductionValue('production')).toBe(true);
    expect(isProductionValue('Production')).toBe(true);
    expect(isProductionValue('  production  ')).toBe(true);
  });

  it('REGRESSION: every ambiguous value is NOT production', () => {
    /*
     * The list is the point. Each of these is a plausible configuration
     * mistake, and every one of them must fail toward "label this page".
     */
    for (const value of [undefined, null, '', '   ', 'prod', 'productionn', 'produciton', 'staging', 'stage', 'dev', 'test', '0', 'false']) {
      expect(isProductionValue(value), `${JSON.stringify(value)} must not read as production`).toBe(false);
    }
  });

  it('normalises absent values to a name, not an empty string', () => {
    // 'unknown' is a state that can be rendered. '' silently formats as nothing.
    expect(normalise(undefined)).toBe('unknown');
    expect(normalise('')).toBe('unknown');
  });
});

describe('production, agreed by both halves', () => {
  it('renders nothing', () => {
    expect(classifyEnvironment('production', 'production').kind).toBe('production');
  });

  it('renders nothing before the API has answered', () => {
    // Otherwise production flashes a banner on every load and then retracts it,
    // which trains people to ignore the banner.
    expect(classifyEnvironment('production', null).kind).toBe('production');
  });

  it('REGRESSION: stays production if the API check fails entirely', () => {
    // A failed fetch leaves apiEnv null. That must not escalate on its own --
    // an unreachable API is a different fact from a disagreeing one.
    expect(classifyEnvironment('production', undefined).kind).toBe('production');
  });
});

describe('anything not production is labelled', () => {
  it('labels staging', () => {
    const v = classifyEnvironment('staging', 'staging');
    expect(v.kind).toBe('labelled');
    expect(v.title).toMatch(/staging/i);
    expect(v.body).toMatch(/synthetic/i);
  });

  it('REGRESSION: labels a page whose environment was never configured', () => {
    /*
     * The most likely real mistake: staging deployed without VITE_ENVIRONMENT
     * set at all. It must not silently pass as production.
     */
    const v = classifyEnvironment(undefined, null);
    expect(v.kind).toBe('labelled');
  });

  it('REGRESSION: labels a misspelled value rather than guessing', () => {
    expect(classifyEnvironment('produciton', null).kind).toBe('labelled');
    expect(classifyEnvironment('prod', null).kind).toBe('labelled');
  });

  it('uses the API name when the build has none', () => {
    const v = classifyEnvironment(undefined, 'staging');
    expect(v.kind).toBe('labelled');
    expect(v.title).toMatch(/staging/i);
  });
});

describe('the mismatch, which is the case a banner alone cannot catch', () => {
  it('REGRESSION: a staging build talking to the production API', () => {
    /*
     * The scenario this whole component exists for. The page is labelled
     * staging and every write lands on real data -- so the label is actively
     * misleading, and the ordinary banner would make it worse by reassuring.
     */
    const v = classifyEnvironment('staging', 'production');

    expect(v.kind).toBe('mismatch');
    expect(v.title).toMatch(/mismatch/i);
    expect(v.body).toMatch(/staging/);
    expect(v.body).toMatch(/production/);
  });

  it('REGRESSION: a production build talking to the staging API', () => {
    // The reverse is less dangerous but equally wrong, and reads to the user as
    // "production has lost all its data".
    expect(classifyEnvironment('production', 'staging').kind).toBe('mismatch');
  });

  it('REGRESSION: mismatch outranks production', () => {
    // If it did not, a production build pointed at staging would render nothing
    // at all -- the quietest possible failure.
    expect(classifyEnvironment('production', 'staging').kind).not.toBe('production');
  });

  it('names both sides, so the reader knows which to fix', () => {
    const v = classifyEnvironment('staging', 'production');
    expect(v.build).toBe('staging');
    expect(v.api).toBe('production');
  });

  it('does not cry mismatch when one side is simply unknown', () => {
    // Unconfigured is not the same as disagreeing. Treating it as a mismatch
    // would fire the loud alert on every un-configured preview deploy, and an
    // alert that fires constantly stops being read.
    expect(classifyEnvironment(undefined, 'staging').kind).toBe('labelled');
    expect(classifyEnvironment('staging', undefined).kind).toBe('labelled');
    expect(classifyEnvironment(undefined, undefined).kind).toBe('labelled');
  });
});
