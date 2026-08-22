/**
 * The URL the API hands the browser for media must be relative.
 *
 * This is the test that was missing while an avatar was broken in production
 * for four rounds of investigation, and the reason it was missing is the useful
 * part.
 *
 * Every existing check read the *database* value -- '/api/media/...', written by
 * migration 017 -- and requested it directly. The database was right, the media
 * route was right, the cookie was right. What was wrong was the step joining
 * them: publicAssetUrl prepended an absolute host at serialisation time, because
 * index.js derived PUBLIC_API_URL from VERCEL_URL. So the browser asked a
 * different origin for the image, could not attach a host-scoped cookie to a
 * cross-origin request, and got 401 every time.
 *
 * Probing the parts individually could not see it. Nothing asserted on what the
 * serialiser actually emits, which is the only thing the browser ever sees.
 *
 * Why relative matters, stated once: /api/media/... is authorised by the
 * nexora_media cookie. Cookies are host-scoped, an <img> cannot carry an
 * Authorization header, and a cross-origin image request therefore arrives with
 * no credential at all. Relative keeps it same-origin, and same-origin is what
 * carries the cookie. This is a security-mechanism constraint, not a style rule.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shapeUser, shapeAuthor, shapePost, publicAssetUrl } = require('../db/helpers.js');
const { publicUser, ownerUser } = require('../db/serialize.js');

const AVATAR = '/api/media/avatars/users/u1/avatar/a1.webp';
const THUMB = '/api/media/avatars/users/u1/avatar/a1-128.webp';
const COVER = '/api/media/covers/users/u1/cover/c1.webp';
const POST_MEDIA = '/api/media/posts/users/u1/post/p1.webp';

const saved = {};
const ENV_KEYS = ['PUBLIC_API_URL', 'API_PUBLIC_URL', 'RENDER_EXTERNAL_URL', 'VERCEL_URL'];

function row() {
  return {
    id: 'u1',
    name: 'Someone',
    email: 'someone@nexora.test',
    avatar: AVATAR,
    avatar_thumb_url: THUMB,
    cover_url: COVER,
    points: 10,
    badges: []
  };
}

/** Every media URL anywhere in a serialised payload. */
function mediaUrlsIn(obj) {
  const found = [];
  JSON.stringify(obj, (_k, v) => {
    if (typeof v === 'string' && v.includes('/api/media/')) found.push(v);
    return v;
  });
  return found;
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/**
 * The production condition, which no previous test simulated.
 *
 * Tests ran with a clean environment, so the absolutising branch never fired
 * and every assertion passed against a value production never produced.
 */
const PRODUCTION_ENVS = [
  ['PUBLIC_API_URL set', { PUBLIC_API_URL: 'https://nexora-api-beta.vercel.app' }],
  ['VERCEL_URL set, PUBLIC_API_URL unset', { VERCEL_URL: 'nexora-4asgj2-abc.vercel.app' }],
  ['API_PUBLIC_URL set', { API_PUBLIC_URL: 'https://nexora-api-beta.vercel.app' }],
  ['RENDER_EXTERNAL_URL set', { RENDER_EXTERNAL_URL: 'https://nexora.onrender.com' }]
];

const SHAPERS = [
  ['shapeUser', () => shapeUser(row())],
  ['shapeAuthor', () => shapeAuthor(row())],
  ['publicUser', () => publicUser(row())],
  ['ownerUser', () => ownerUser(row())],
  ['shapePost', () => shapePost(
    { id: 'p1', content: 'x', created_at: 'now' },
    { author: shapeAuthor(row()), media: [{ type: 'image', url: POST_MEDIA }] }
  )]
];

describe('media URLs stay relative, whatever the environment says', () => {
  for (const [envName, env] of PRODUCTION_ENVS) {
    for (const [shaperName, build] of SHAPERS) {
      it(`REGRESSION: ${shaperName} emits relative media URLs with ${envName}`, () => {
        for (const k of ENV_KEYS) delete process.env[k];
        Object.assign(process.env, env);

        const urls = mediaUrlsIn(build());

        // Non-empty, or the assertion below proves nothing.
        expect(urls.length, `${shaperName} produced no media URL to check`).toBeGreaterThan(0);

        for (const u of urls) {
          expect(u, `${shaperName} returned an absolute media URL`).toMatch(/^\/api\/media\//);
          expect(u).not.toMatch(/^https?:\/\//);
        }
      });
    }
  }
});

describe('publicAssetUrl directly', () => {
  it('REGRESSION: never prepends a host to a media path', () => {
    process.env.PUBLIC_API_URL = 'https://some-deployment.vercel.app';
    expect(publicAssetUrl(AVATAR)).toBe(AVATAR);
    expect(publicAssetUrl(COVER)).toBe(COVER);
    expect(publicAssetUrl(POST_MEDIA)).toBe(POST_MEDIA);
  });

  it('passes through absolute and data URLs untouched', () => {
    // Rows written before migration 017 could still hold an absolute URL.
    expect(publicAssetUrl('https://cdn.example/x.png')).toBe('https://cdn.example/x.png');
    expect(publicAssetUrl('data:image/png;base64,AAA')).toBe('data:image/png;base64,AAA');
  });

  it('handles empty and non-string input', () => {
    expect(publicAssetUrl('')).toBe('');
    expect(publicAssetUrl(null)).toBe('');
    expect(publicAssetUrl(undefined)).toBe('');
  });

  it('still absolutises a legacy non-media path', () => {
    /*
     * The branch is kept for /uploads/..., which nothing writes any more.
     * Asserted so that removing the media exemption cannot be mistaken for
     * removing the whole feature -- and so the next person can see the
     * distinction is deliberate rather than accidental.
     */
    process.env.PUBLIC_API_URL = 'https://api.example';
    expect(publicAssetUrl('/uploads/legacy.png')).toBe('https://api.example/uploads/legacy.png');
  });
});

describe('the boot-time environment derivation', () => {
  it('REGRESSION: VERCEL_URL is never used to derive PUBLIC_API_URL', async () => {
    /*
     * The origin of the outage. VERCEL_URL is the per-deployment hostname, so
     * deriving a public URL from it produced a different absolute host on every
     * deploy -- and one that is never the alias the browser is on.
     *
     * Asserted by reading the source rather than booting the server: startServer
     * mounts every route and asserts on secrets, which is far more than this
     * needs to know.
     */
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');

    expect(src).not.toMatch(/PUBLIC_API_URL\s*=\s*[`'"]https:\/\/\$\{?process\.env\.VERCEL_URL/);
    expect(src).not.toMatch(/PUBLIC_API_URL\s*=\s*`https:\/\/\$\{process\.env\.VERCEL_URL\}`/);
  });
});
