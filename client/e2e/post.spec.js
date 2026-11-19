/**
 * Posting from the feed composer, including the direct-to-storage upload.
 *
 * The upload is two-phase: presign, then the browser PUTs the bytes straight to
 * storage, then the post is created with only the object key. If any phase
 * regressed to sending bytes through the API, it would still "work" locally
 * and fail on Vercel, whose functions cap request bodies near 4.5MB.
 */
import { test, expect } from '@playwright/test';
import { installMockApi, logIn, STORAGE_ORIGIN } from './mockApi.js';

// A 2x2 PNG, enough for the browser to decode, downscale and re-encode.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEJMDGgAQYGBgCv1QQB9z0iOQAAAABJRU5ErkJggg==',
  'base64'
);

let api;

test.beforeEach(async ({ page }) => {
  api = await installMockApi(page);
  await logIn(page);
});

test.afterEach(() => {
  expect(api.unexpected, 'endpoints with no e2e fixture').toEqual([]);
  expect(api.uiErrors, 'pages that crashed into the error boundary').toEqual([]);
});

/** The feed shows a "What's on your mind" button; the textarea opens from it. */
async function composer(page) {
  await page.getByRole('button', { name: /What's on your mind/ }).click();
  return page.getByPlaceholder(/What's on your mind/);
}
const postButton = (page) => page.getByRole('button', { name: 'Post', exact: true });

test('a text post is sent as JSON and appears at the top of the feed', async ({ page }) => {
  await (await composer(page)).fill('Hello from the e2e suite');
  const published = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/posts');
  await postButton(page).click();
  await published;

  await expect(page.locator('.post-content', { hasText: 'Hello from the e2e suite' })).toBeVisible();
  expect(api.lastPostBody).toMatchObject({ content: 'Hello from the e2e suite', mediaKeys: [] });
});

test('REGRESSION: an image goes straight to storage, and the post carries only its key', async ({ page }) => {
  await (await composer(page)).fill('With a picture');
  await page.locator('input[type="file"][accept="image/*,video/*"]').setInputFiles({
    name: 'tiny.png', mimeType: 'image/png', buffer: PNG
  });
  const published = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/posts');
  await postButton(page).click();
  await published;

  await expect(page.locator('.post-content', { hasText: 'With a picture' })).toBeVisible();

  // Phase 2: one PUT, to storage, not to the API.
  expect(api.uploads).toHaveLength(1);
  expect(api.uploads[0].method).toBe('PUT');
  expect(api.uploads[0].url.startsWith(STORAGE_ORIGIN)).toBe(true);

  // Phase 3: JSON with the key the presign issued -- no multipart body.
  expect(api.lastPostBody.mediaKeys).toHaveLength(1);
  expect(api.lastPostBody.mediaKeys[0]).toMatch(/^post\//);
  expect(api.count('POST', '/api/uploads/presign')).toBe(1);
});
