/**
 * The session, end to end: login, the refresh-token cycle, and logout.
 *
 * The README listed "the session, the refresh cycle, and anything that only
 * breaks after an interaction" as uncovered. These are the cases where a bug
 * costs a user their session: a reload that logs them out, a burst of expired
 * requests that each start their own refresh (rotation then revokes the
 * family -- a logout for loading a busy page), or a dead session that leaves
 * them on a page full of 401s.
 */
import { test, expect } from '@playwright/test';
import { installMockApi, logIn, EMAIL } from './mockApi.js';

let api;

test.beforeEach(async ({ page }) => {
  api = await installMockApi(page);
});

test.afterEach(() => {
  expect(api.unexpected, 'endpoints with no e2e fixture').toEqual([]);
  expect(api.uiErrors, 'pages that crashed into the error boundary').toEqual([]);
});

test('logs in through the form and lands on the feed', async ({ page }) => {
  await logIn(page);
  await expect(page.getByText('A post that exists').first()).toBeVisible();
});

test('a wrong password stays on /login and shows the server message', async ({ page }) => {
  await page.goto('/login');
  await page.getByPlaceholder('Email address').fill(EMAIL);
  await page.locator('input[type="password"]').first().fill('wrong password');
  await page.getByRole('button', { name: 'Log In' }).click();

  await expect(page.getByText('Invalid email or password')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test('the session survives a reload through the refresh cookie', async ({ page }) => {
  await logIn(page);
  const refreshesBefore = api.count('POST', '/api/auth/refresh');

  await page.reload();

  // The access token lived in memory and died with the reload; the refresh
  // cookie is what brings the session back.
  await expect(page.getByText('A post that exists').first()).toBeVisible();
  await expect(page).toHaveURL(/\/feed$/);
  expect(api.count('POST', '/api/auth/refresh')).toBe(refreshesBefore + 1);
});

/** Requests since `from` that went out with one of `expired` and were rejected. */
function burstSince(api, from, expired) {
  const after = api.calls.slice(from);
  // The refresh call itself carries the old header too; it is not a rejection.
  const rejected = after.filter((c) => c.path !== '/api/auth/refresh' && expired.has(c.token));
  const again = after.filter((c) => c.token && !expired.has(c.token));
  return { rejected, again };
}

async function expireAndOpenLeaderboard(page, api, holds) {
  // Fifteen minutes pass: every access token issued so far is now expired.
  const expired = new Set(api.validTokens);
  api.expireAccessTokens();
  Object.assign(api, holds);
  const from = api.calls.length;
  const refreshesBefore = api.count('POST', '/api/auth/refresh');

  // A page this session has not visited, so nothing is cached: its own fetch
  // and the navbar's notifications fetch go out together, both expired.
  const replayed = page.waitForResponse(
    (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/rewards/leaderboard' && r.status() === 200
  );
  await page.getByRole('button', { name: 'Leaderboard', exact: true }).click();
  await replayed;
  await expect(page.getByText('Third Person').first()).toBeVisible();

  // Each rejected request is sent again with the new token (replays settle
  // independently, so poll until they all have).
  await expect.poll(() => {
    const { rejected, again } = burstSince(api, from, expired);
    return rejected.every((r) => again.some((c) => c.method === r.method && c.path === r.path));
  }).toBe(true);
  return { ...burstSince(api, from, expired), refreshes: api.count('POST', '/api/auth/refresh') - refreshesBefore };
}

test('REGRESSION: requests failing together trigger ONE refresh, then all replay', async ({ page }) => {
  await logIn(page);
  // Hold every 401 longer than the page's lazy chunk takes to load, so all
  // the expired requests are genuinely in flight together, and hold the
  // refresh too, so every 401 arrives while that one refresh is running.
  const { rejected, refreshes } = await expireAndOpenLeaderboard(page, api, {
    hold401Ms: 2000,
    holdRefreshMs: 2000
  });

  expect(rejected.length, 'requests in flight with the expired token').toBeGreaterThan(1);
  // One refresh for the whole burst: a second would present a token the first
  // already rotated away, which the server treats as theft.
  expect(refreshes).toBe(1);
});

test('REGRESSION: a 401 that lands after the refresh finished is replayed, not refreshed again', async ({ page }) => {
  await logIn(page);
  // The notifications 401 comes back at once and starts a slow refresh; the
  // leaderboard request goes out during it, with the old token, and its 401 is
  // held until well after the refresh has completed.
  const { rejected, refreshes } = await expireAndOpenLeaderboard(page, api, {
    // Long enough that the page's lazy chunk has loaded and sent its request
    // before the refresh answers, whatever the machine's speed.
    holdRefreshMs: 1500,
    hold401For: { '/api/rewards/leaderboard': 2500 }
  });

  expect(rejected.map((c) => c.path)).toContain('/api/rewards/leaderboard');
  expect(refreshes).toBe(1);
});

test('a revoked session sends the user to /login instead of a page of errors', async ({ page }) => {
  await logIn(page);

  api.revokeSession();
  // An in-app navigation, so the 401 -> refresh -> 401 path runs inside the
  // live app rather than in a fresh page load. Background polling can hit the
  // dead session first and log out before the click lands; either way the user
  // must end up on /login, so a click that finds no button is not a failure.
  const onLogin = page.waitForURL(/\/login$/);
  await page.getByRole('button', { name: 'Q&A', exact: true }).click({ timeout: 5_000 }).catch(() => {});
  await onLogin;

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: 'Log In' })).toBeVisible();
});

test('logging out revokes the session server-side, so a reload stays logged out', async ({ page }) => {
  await logIn(page);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: /logout/i }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(api.count('POST', '/api/auth/logout')).toBe(1);

  await page.goto('/feed');
  await expect(page).toHaveURL(/\/login$/);
});
