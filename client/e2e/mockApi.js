/**
 * A stateful stand-in for the API, installed per page with page.route().
 *
 * It models the parts of the server contract the session depends on:
 *
 *   - login issues an access token and a refresh "cookie" (state here, since
 *     the real one is httpOnly and same-site to the API)
 *   - POST /api/auth/refresh rotates: the old access token stops working and a
 *     new one is issued; a revoked session answers 401
 *   - every other call needs a currently valid Bearer token, else 401
 *
 * GET bodies come from src/test/fixtures.js, the same fixtures the mount suite
 * uses, so the two cannot disagree about what a page receives. An endpoint
 * with no fixture is recorded in `unexpected` and answered 404; each test
 * asserts that list is empty, for the reason fixtures.js gives: a silent empty
 * default hides what a page would have rendered.
 */
import { FIXTURES, resolveFixture, CURRENT_USER } from '../src/test/fixtures.js';

export const EMAIL = CURRENT_USER.email;
export const PASSWORD = 'correct horse battery staple';
export const STORAGE_ORIGIN = 'https://storage.e2e.test';

export async function installMockApi(page, { loggedIn = false } = {}) {
  const state = {
    sessionAlive: loggedIn,
    validTokens: new Set(),
    tokenSeq: 0,
    calls: [],
    unexpected: [],
    posts: [...FIXTURES['/api/posts'].posts],
    uploads: []
  };

  /*
   * A page crash is caught by ErrorBoundary, which reports it with a keepalive
   * fetch -- and keepalive requests are not interceptable, so it would slip
   * past the mock silently. Record the boundary's console line instead, so a
   * test can fail on it.
   */
  state.uiErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && m.text().includes('Unhandled UI error')) state.uiErrors.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => state.uiErrors.push(`pageerror: ${e.message.slice(0, 300)}`));

  const issueToken = () => {
    const t = `access-${++state.tokenSeq}`;
    state.validTokens.add(t);
    return t;
  };

  const json = (route, status, body) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  /** Expire every access token now, as 15 minutes passing would. */
  state.expireAccessTokens = () => state.validTokens.clear();
  /** Revoke the refresh token too: the session is over server-side. */
  state.revokeSession = () => { state.sessionAlive = false; state.validTokens.clear(); };
  state.count = (method, path) => state.calls.filter(c => c.method === method && c.path === path).length;

  /*
   * The browser PUTs uploads straight to storage, never through the API. It is
   * a cross-origin PUT with a Content-Type, so the browser preflights it and
   * needs CORS headers on both answers, as real storage sends.
   */
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'PUT, OPTIONS',
    'access-control-allow-headers': '*'
  };
  await page.route(`${STORAGE_ORIGIN}/**`, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' });
    state.uploads.push({ method: req.method(), url: req.url(), contentType: req.headers()['content-type'] });
    return route.fulfill({ status: 200, headers: cors, body: '' });
  });

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/\/$/, '');
    const method = req.method();
    const auth = req.headers().authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    state.calls.push({ method, path, token });

    // ── Session endpoints ─────────────────────────────────
    if (method === 'POST' && path === '/api/auth/login') {
      const body = req.postDataJSON() || {};
      if (body.email !== EMAIL || body.password !== PASSWORD) {
        return json(route, 401, { message: 'Invalid email or password' });
      }
      state.sessionAlive = true;
      return json(route, 200, { token: issueToken(), user: CURRENT_USER });
    }
    if (method === 'POST' && path === '/api/auth/refresh') {
      if (!state.sessionAlive) return json(route, 401, { message: 'Session expired' });
      // Optionally slow the refresh, so requests can go out while it runs.
      if (state.holdRefreshMs) await new Promise((r) => setTimeout(r, state.holdRefreshMs));
      state.validTokens.clear();  // rotation: the previous access token is dead
      return json(route, 200, { token: issueToken() });
    }
    if (method === 'POST' && path === '/api/auth/logout') {
      state.sessionAlive = false;
      state.validTokens.clear();
      return json(route, 200, { message: 'Logged out' });
    }

    // Public probes the client may read before login.
    if (method === 'GET' && (path === '/api/version' || path === '/api/health')) {
      return json(route, 200, resolveFixture(path));
    }

    // ── Everything else needs a live access token ─────────
    if (!token || !state.validTokens.has(token)) {
      // Optionally hold the 401 back, so a burst of requests is genuinely in
      // flight together before the first rejection reaches the client.
      const hold = (state.hold401For && state.hold401For[path]) ?? state.hold401Ms;
      if (hold) await new Promise((r) => setTimeout(r, hold));
      return json(route, 401, { message: 'Not authorized, token failed' });
    }

    if (method === 'POST' && path === '/api/uploads/presign') {
      const body = req.postDataJSON() || {};
      const key = `post/${CURRENT_USER.id}/e2e-${state.uploads.length + 1}.webp`;
      return json(route, 200, {
        key,
        signedUrl: `${STORAGE_ORIGIN}/upload/${encodeURIComponent(key)}?token=t`,
        contentType: body.mimeType || 'application/octet-stream'
      });
    }

    if (method === 'POST' && path === '/api/posts') {
      const body = req.postDataJSON() || {};
      const post = {
        ...state.posts[0],
        _id: `e2e-${state.posts.length + 1}`,
        id: `e2e-${state.posts.length + 1}`,
        author: CURRENT_USER,
        content: body.content || '',
        media: (body.mediaKeys || []).map((k) => ({ type: 'image', url: `/api/media/posts/${k}` })),
        likes: [],
        comments: [],
        createdAt: new Date().toISOString()
      };
      state.posts.unshift(post);
      state.lastPostBody = body;
      return json(route, 201, { post, postsToday: 1 });
    }

    if (method === 'GET' && path === '/api/posts') {
      return json(route, 200, { ...FIXTURES['/api/posts'], posts: state.posts });
    }

    if (method === 'GET') {
      try {
        return json(route, 200, resolveFixture(path));
      } catch {
        state.unexpected.push(`${method} ${path}`);
        return json(route, 404, { message: 'no e2e fixture' });
      }
    }

    state.unexpected.push(`${method} ${path}`);
    return json(route, 404, { message: 'no e2e handler' });
  });

  return state;
}

/**
 * Log in through the real form, and wait for the feed's first load to finish,
 * so a test that changes the session afterwards is not racing the page's own
 * startup requests.
 */
export async function logIn(page) {
  await page.goto('/login');
  await page.getByPlaceholder('Email address').fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  const feedLoaded = page.waitForResponse(
    (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/posts' && r.status() === 200
  );
  await page.getByRole('button', { name: 'Log In' }).click();
  await page.waitForURL('**/feed');
  await feedLoaded;
}
