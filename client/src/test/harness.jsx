import { resolveFixture } from './fixtures.js';

/**
 * The pieces a page needs before it can mount outside a browser.
 *
 * Two decisions worth stating, because both were choices between a faithful
 * harness and a convenient one.
 *
 * **It mocks `../services/api`, not axios.** That module's five exports are the
 * entire network surface, so replacing it lets the real AuthProvider run its
 * real boot sequence -- refreshAccessToken(), then GET /api/auth/me -- against
 * fixtures. AuthContext is not exported and this is better than exporting it:
 * the provider is exercised rather than bypassed, and the boot ordering that
 * caused a media-cookie bug earlier is under test rather than stubbed away.
 *
 * **It renders the real `<App />` at a pushed history entry**, rather than
 * assembling a tree of the page under test. BrowserRouter reads from history,
 * so the actual route table, ProtectedRoute and the lazy chunks all
 * participate. A hand-built tree would pass while the router config was broken,
 * which is a class of failure worth catching here rather than in production.
 */

/** Requests the harness saw, so a test can assert what a page asked for. */
export const requests = [];

/** A minimal axios stand-in: only what the app actually calls. */
function makeApiMock() {
  const respond = (url) => Promise.resolve({ data: resolveFixture(url), status: 200 });

  const api = {
    get: (url) => { requests.push(['get', url]); return respond(url); },
    // Writes are not what a mount smoke test exercises; resolve so nothing hangs.
    post: (url) => { requests.push(['post', url]); return Promise.resolve({ data: {}, status: 200 }); },
    put: (url) => { requests.push(['put', url]); return Promise.resolve({ data: {}, status: 200 }); },
    patch: (url) => { requests.push(['patch', url]); return Promise.resolve({ data: {}, status: 200 }); },
    delete: (url) => { requests.push(['delete', url]); return Promise.resolve({ data: {}, status: 200 }); },
    defaults: { headers: { common: {} } },
    interceptors: { request: { use: () => {} }, response: { use: () => {} } }
  };

  return {
    default: api,
    refreshAccessToken: () => Promise.resolve('test-access-token'),
    getAccessToken: () => 'test-access-token',
    setAccessToken: () => {},
    baseURL: ''
  };
}

export const apiMock = makeApiMock;

/**
 * Browser APIs jsdom does not implement, counted from the source rather than
 * added until the errors stopped: matchMedia (5 uses), scrollTo (4),
 * navigator.clipboard (4), URL.createObjectURL (3), IntersectionObserver (2).
 */
export function installBrowserStubs() {
  if (!window.matchMedia) {
    window.matchMedia = (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false
    });
  }

  window.scrollTo = () => {};
  Element.prototype.scrollTo = Element.prototype.scrollTo || (() => {});
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});

  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  }
  window.IntersectionObserver = window.IntersectionObserver || Observer;
  window.ResizeObserver = window.ResizeObserver || Observer;

  if (!navigator.clipboard) {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.resolve(), readText: () => Promise.resolve('') }
    });
  }

  if (!navigator.serviceWorker) {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistrations: () => Promise.resolve([]), register: () => Promise.resolve() }
    });
  }

  URL.createObjectURL = URL.createObjectURL || (() => 'blob:test');
  URL.revokeObjectURL = URL.revokeObjectURL || (() => {});
}

/** Point the router at `path` before rendering the real App. */
export function goTo(path) {
  window.history.pushState({}, '', path);
}

/**
 * Did the app fall into its error boundary?
 *
 * Checked by heading rather than by watching for a throw: React catches the
 * throw, so a boundary render is the only visible evidence that a page died.
 * Asserting "no exception escaped" alone would miss every caught crash --
 * which is every crash this harness exists to find.
 */
export function boundaryRendered(container) {
  const text = container.textContent || '';
  return /Something broke|This page is broken|A new version is available/.test(text);
}
