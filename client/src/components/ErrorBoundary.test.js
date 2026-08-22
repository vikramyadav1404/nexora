/**
 * The boundary's transient-vs-permanent decision.
 *
 * Written because the old boundary told everyone "Reloading usually clears it"
 * while /leaderboard threw ReferenceError on every render for every visitor. A
 * permanent failure dressed as a transient one is the same collapse as an empty
 * state hiding a failed request: the user is told to try something that cannot
 * work, and the real problem stays invisible.
 *
 * classify() is the judgement the component exists to make, so it is asserted
 * directly rather than through a rendered tree -- there is no DOM harness here,
 * and a decision worth testing should not need one.
 */
import { describe, it, expect } from 'vitest';
import { classify, errorSignature } from './ErrorBoundary.jsx';

const chunkError = () => {
  const e = new Error('Failed to fetch dynamically imported module: /assets/Feed-abc.js');
  e.name = 'TypeError';
  return e;
};

const renderError = () => {
  const e = new ReferenceError('loading is not defined');
  e.stack = 'ReferenceError: loading is not defined\n    at h (/assets/Leaderboard-B2EKTN04.js:1:2207)\n    at To (/assets/index.js:9:47535)';
  return e;
};

describe('a stale build', () => {
  it('is transient, and reloading genuinely fixes it', () => {
    const v = classify(chunkError(), null);
    expect(v.kind).toBe('stale');
    expect(v.reloadHelps).toBe(true);
    expect(v.title).toMatch(/new version/i);
  });

  it('REGRESSION: stays transient even after a reload attempt', () => {
    /*
     * A chunk error recurring usually means another deploy landed between the
     * two loads, not that reloading is useless. Treating it as permanent would
     * strand people on the one failure a reload actually does fix.
     */
    const v = classify(chunkError(), errorSignature(chunkError()));
    expect(v.kind).toBe('stale');
    expect(v.reloadHelps).toBe(true);
  });
});

describe('a render error nobody has tried to reload yet', () => {
  it('offers a reload but does not promise it will work', () => {
    const v = classify(renderError(), null);
    expect(v.kind).toBe('unknown');
    expect(v.reloadHelps).toBe(true);
    // The old copy said "Reloading usually clears it" -- an assertion the
    // boundary had no basis for.
    expect(v.body).not.toMatch(/usually clears it/i);
  });
});

describe('a render error that survived a reload', () => {
  it('REGRESSION: stops recommending the thing that just failed', () => {
    const err = renderError();
    const v = classify(err, errorSignature(err));

    expect(v.kind).toBe('permanent');
    expect(v.reloadHelps).toBe(false);
    expect(v.body).toMatch(/did not fix/i);
  });

  it('says it is our bug, not the user\'s session', () => {
    const err = renderError();
    expect(classify(err, errorSignature(err)).body).toMatch(/our side|bug/i);
  });
});

describe('the signature', () => {
  it('matches the same failure across two loads', () => {
    expect(errorSignature(renderError())).toBe(errorSignature(renderError()));
  });

  it('REGRESSION: distinguishes two different failures', () => {
    // Otherwise any second error would be reported as "reloading did not help"
    // for a problem the user has never seen before.
    const other = new TypeError('x.map is not a function');
    other.stack = 'TypeError: x.map is not a function\n    at q (/assets/Feed.js:2:100)';
    expect(errorSignature(renderError())).not.toBe(errorSignature(other));
  });

  it('ignores stack frames past the first, which shift between builds', () => {
    const a = renderError();
    const b = renderError();
    b.stack = 'ReferenceError: loading is not defined\n    at h (/assets/Leaderboard-B2EKTN04.js:1:2207)\n    at DIFFERENT (/assets/index-other.js:1:1)';
    expect(errorSignature(a)).toBe(errorSignature(b));
  });

  it('does not throw on a malformed error', () => {
    expect(() => errorSignature(null)).not.toThrow();
    expect(() => errorSignature({})).not.toThrow();
    expect(() => errorSignature('a string')).not.toThrow();
  });
});
