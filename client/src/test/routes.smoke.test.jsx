/**
 * @vitest-environment jsdom
 *
 * Every route mounts.
 *
 * The argument for this file: `ReferenceError: loading is not defined` shipped
 * to production on /leaderboard, threw on every render for every visitor, and
 * was found by a person opening a browser. Nothing in CI looked. This is the
 * cheapest thing that would have caught it, and it gets more valuable as pages
 * are added, not less.
 *
 * Scope is deliberately mount-only. Not coverage, not behaviour -- proof that
 * each page can render with plausible data without dying. A page that mounts
 * can be wrong; a page that does not mount is wrong for everybody.
 *
 * jsdom is requested per-file rather than globally: the other two client test
 * files run without a DOM, and ErrorBoundary.test.js stubs globalThis.location,
 * which jsdom would fight over.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { apiMock, installBrowserStubs, goTo, boundaryRendered, requests } from './harness.jsx';
import { ME, OTHER, FIXTURES } from './fixtures.js';

// Hoisted by vitest, so the app's own import of this module is replaced before
// any page is loaded.
vi.mock('../services/api', () => apiMock());

let App;

beforeAll(async () => {
  installBrowserStubs();
  App = (await import('../App.jsx')).default;
});

beforeEach(() => {
  requests.length = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * Each route, and a string that proves *that* page rendered.
 *
 * The marker is the point of the table. ProtectedRoute redirects to /onboarding
 * unless the current user has onboardingCompleted, so without a per-route
 * assertion a single wrong fixture field would send all fifteen routes to the
 * same screen and every one of them would pass. That exact vacuous pass has
 * already happened twice this month -- an empty `people: []` and a wrong mount
 * path -- so it is designed out rather than watched for.
 */
const ROUTES = [
  ['/feed', /post|feed|share/i],
  ['/qa', /question/i],
  ['/ask', /ask|question/i],
  ['/subscriptions', /plan|subscription|free/i],
  [`/profile/${ME}`, /Vikram|profile|points/i],
  [`/profile/${OTHER}`, /Asha|profile|points/i],
  ['/settings', /setting|account|password/i],
  ['/leaderboard', /top contributors|leaderboard/i],
  ['/search', /search/i],
  ['/notifications', /notification/i],
  ['/spaces', /space|technology/i],
  ['/spaces/technology', /technology/i],
  ['/bookmarks', /bookmark/i],
  ['/challenges', /challenge|streak/i],
  ['/admin', /admin|report|stat/i],
  ['/terms', /terms/i],
  ['/privacy', /privacy/i]
];

describe('every route mounts without dying', () => {
  for (const [path, marker] of ROUTES) {
    it(`REGRESSION: ${path} renders`, async () => {
      const errors = [];
      vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' ')));

      goTo(path);
      const { container } = render(<App />);

      // Lazy chunk + AuthProvider boot + the page's own fetches.
      await waitFor(() => {
        expect(container.textContent.length).toBeGreaterThan(0);
      }, { timeout: 5000 });

      await waitFor(() => {
        expect(screen.queryByText(/Loading/i)).toBeNull();
      }, { timeout: 5000 }).catch(() => { /* some pages have no loading text */ });

      /*
       * The boundary is the real signal. React catches render throws, so an
       * uncaught exception never reaches the test -- a boundary render is the
       * only visible evidence the page died. Asserting "nothing threw" alone
       * would miss every crash this file exists to find.
       */
      expect(
        boundaryRendered(container),
        `${path} fell into the error boundary:\n${errors.slice(0, 2).join('\n')}`
      ).toBe(false);

      /*
       * And it must be *this* page's own content.
       *
       * Scoped to .page-container, which every routed page wraps itself in and
       * the Navbar sits outside of. Matching against the whole document was
       * the first version and it was quietly broken: /leaderboard passed with
       * the page rendering `null`, because the navbar contains the word
       * "Leaderboard". Verified by neutering three pages to `return null` --
       * two failed, and the one whose name appears in the nav did not.
       *
       * Requiring the element also covers the null case: a page that renders
       * nothing has no .page-container, so this fails before the text match.
       */
      await waitFor(() => {
        const page = container.querySelector('.page-container');
        expect(page, `${path} rendered no .page-container — the page did not mount`).toBeTruthy();
        expect(page.textContent).toMatch(marker);
      }, { timeout: 5000 });
    }, 20000);
  }
});

describe('the harness itself', () => {
  it('REGRESSION: an unknown endpoint fails loudly instead of returning nothing', async () => {
    /*
     * The fixture map throws on an unmatched URL. If it returned {} instead, a
     * page calling a new endpoint would mount, render nothing, and pass -- the
     * same shape of false green as an empty search result.
     */
    const { resolveFixture } = await import('./fixtures.js');
    expect(() => resolveFixture('/api/not-a-real-endpoint')).toThrow(/No fixture/);
  });

  it('signs in as a user who has completed onboarding', async () => {
    // If this ever becomes false, every route test above starts asserting
    // against the onboarding screen instead of the page it names.
    const { CURRENT_USER } = await import('./fixtures.js');
    expect(CURRENT_USER.onboardingCompleted).toBe(true);
  });

  it('actually exercises the auth boot sequence', async () => {
    goTo('/leaderboard');
    render(<App />);
    await waitFor(() => {
      expect(requests.some(([, url]) => url.includes('/api/auth/me'))).toBe(true);
    }, { timeout: 5000 });
  }, 20000);
});

describe('the environment banner', () => {
  /*
   * Every route test above runs with VITE_ENVIRONMENT undefined, so the banner
   * is present in all of them and none of them would notice if it stopped
   * distinguishing anything. The matrix that matters is build x api, and it is
   * only meaningful because the absent case sits beside the present ones.
   *
   * vi.stubEnv reaches import.meta.env, which is where the build-time half
   * actually comes from -- asserting against a hand-passed argument would test
   * the classifier again rather than the component reading its own environment.
   */
  const original = FIXTURES['/api/version'];

  afterEach(() => {
    FIXTURES['/api/version'] = original;
    vi.unstubAllEnvs();
  });

  const mount = async (buildEnv, apiEnv) => {
    vi.stubEnv('VITE_ENVIRONMENT', buildEnv);
    FIXTURES['/api/version'] = { ...original, environment: apiEnv, isProduction: apiEnv === 'production' };
    goTo('/leaderboard');
    const { container } = render(<App />);
    await waitFor(() => {
      expect(container.querySelector('.page-container')).toBeTruthy();
    }, { timeout: 5000 });
    return container;
  };

  const bannerIn = (c) => c.querySelector('[data-testid="environment-banner"]');

  it('REGRESSION: renders nothing when both halves agree on production', async () => {
    const container = await mount('production', 'production');
    // Give the /api/version round trip a chance to arrive and escalate.
    await new Promise(r => setTimeout(r, 50));
    expect(bannerIn(container), 'a banner appeared on a production build').toBeNull();
  }, 20000);

  it('REGRESSION: renders on a staging deployment', async () => {
    const container = await mount('staging', 'staging');
    await waitFor(() => {
      const banner = bannerIn(container);
      expect(banner, 'no banner on a staging deployment').toBeTruthy();
      expect(banner.getAttribute('data-env-kind')).toBe('labelled');
      expect(banner.textContent).toMatch(/synthetic/i);
    }, { timeout: 5000 });
  }, 20000);

  it('REGRESSION: renders on a deployment nobody configured', async () => {
    // The likeliest real mistake: staging shipped without VITE_ENVIRONMENT.
    const container = await mount(undefined, 'staging');
    await waitFor(() => {
      expect(bannerIn(container), 'an unconfigured build was treated as production').toBeTruthy();
    }, { timeout: 5000 });
  }, 20000);

  it('REGRESSION: a staging build on the production API renders the loud variant', async () => {
    /*
     * The case a banner alone cannot catch, and the reason the API value is
     * fetched at all. The page would otherwise be labelled staging while every
     * write lands on real data -- worse than no label, because it reassures.
     */
    const container = await mount('staging', 'production');
    await waitFor(() => {
      const banner = bannerIn(container);
      expect(banner, 'no banner on a mismatched deployment').toBeTruthy();
      expect(banner.getAttribute('data-env-kind')).toBe('mismatch');
      expect(banner.textContent).toMatch(/mismatch/i);
    }, { timeout: 5000 });
  }, 20000);
});
