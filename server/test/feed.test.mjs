/**
 * Feed pagination and image handling — the two areas with no coverage before.
 *
 * The feed cursor is worth testing because the bug it replaced was subtle: the
 * old page-based feed capped at 60 posts and could show a post twice or skip it
 * entirely as the ranking window shifted between requests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

process.env.JWT_SECRET = 'test_jwt_secret';

const require = createRequire(import.meta.url);
const { __setTestClient } = require('../db/supabase.js');
const jwt = require('jsonwebtoken');
const { optimizeImage } = require('../utils/image.js');
const { escapePostgrestValue } = require('../utils/validate.js');

const USER = {
  id: '00000000-0000-4000-8000-00000000f001',
  name: 'Feed Tester',
  email: 'feed@nexora.test',
  points: 50,
  interests: ['technology'],
  is_active: true,
  posts_today: 0
};

let db;
const token = () => jwt.sign({ id: USER.id }, process.env.JWT_SECRET, { expiresIn: '1h' });

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/posts', require('../routes/posts.js'));
  return a;
}

/** N posts, newest first, one minute apart. */
function seedPosts(n) {
  const base = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    id: `post-${String(i).padStart(3, '0')}`,
    author_id: USER.id,
    content: `post number ${i}`,
    is_public: true,
    interest_tags: ['technology'],
    shares: 0,
    created_at: new Date(base - i * 60_000).toISOString()
  }));
}

beforeEach(() => {
  db = createFakeSupabase({ users: [{ ...USER }] });
  __setTestClient(db);
  process.env.NODE_ENV = 'test';
});

describe('GET /api/posts — cursor pagination', () => {
  it('returns a cursor and hasMore when more posts exist', async () => {
    db._tables.posts = seedPosts(25);

    const res = await request(app())
      .get('/api/posts?limit=10')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    expect(res.body.posts).toHaveLength(10);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.nextCursor).toBeTruthy();
  });

  it('reports hasMore=false and a null cursor on the last page', async () => {
    db._tables.posts = seedPosts(4);

    const res = await request(app())
      .get('/api/posts?limit=10')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.body.posts).toHaveLength(4);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.nextCursor).toBeNull();
  });

  it('REGRESSION: is not capped at 60 posts', async () => {
    // The old implementation fetched a 60-row window and reported its length as
    // the total, so the feed could never show more than 60 posts.
    db._tables.posts = seedPosts(150);

    const res = await request(app())
      .get('/api/posts?limit=50')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.body.posts).toHaveLength(50);
    expect(res.body.hasMore).toBe(true);
    // The response must not carry the old page/total contract at all.
    expect(res.body.total).toBeUndefined();
    expect(res.body.pages).toBeUndefined();
  });

  it('clamps limit to a sane range', async () => {
    db._tables.posts = seedPosts(120);

    const huge = await request(app())
      .get('/api/posts?limit=9999')
      .set('Authorization', `Bearer ${token()}`);
    expect(huge.body.posts.length).toBeLessThanOrEqual(50);

    const zero = await request(app())
      .get('/api/posts?limit=0')
      .set('Authorization', `Bearer ${token()}`);
    expect(zero.body.posts.length).toBeGreaterThan(0);
  });

  it('survives a malformed cursor instead of 500ing', async () => {
    db._tables.posts = seedPosts(5);

    const res = await request(app())
      .get('/api/posts?cursor=!!!not-base64!!!')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.posts)).toBe(true);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app()).get('/api/posts');
    expect(res.status).toBe(401);
  });
});

describe('image optimization', () => {
  // A 1200x1200 PNG of solid colour — large on disk, trivially compressible.
  async function bigPng() {
    const sharp = require('sharp');
    return sharp({
      create: { width: 1200, height: 1200, channels: 3, background: { r: 200, g: 40, b: 90 } }
    }).png().toBuffer();
  }

  it('shrinks a large image and converts it to webp', async () => {
    const buffer = await bigPng();
    const { file, optimized, saved } = await optimizeImage(
      { buffer, mimetype: 'image/png', originalname: 'photo.png' },
      { kind: 'post' }
    );

    expect(optimized).toBe(true);
    expect(file.mimetype).toBe('image/webp');
    expect(file.originalname).toMatch(/\.webp$/);
    expect(file.buffer.length).toBeLessThan(buffer.length);
    expect(saved).toBeGreaterThan(50);
  });

  it('caps dimensions so a huge upload cannot reach storage full size', async () => {
    const sharp = require('sharp');
    const buffer = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: { r: 10, g: 10, b: 10 } }
    }).png().toBuffer();

    const { file } = await optimizeImage(
      { buffer, mimetype: 'image/png', originalname: 'huge.png' },
      { kind: 'post' }
    );

    const meta = await sharp(file.buffer).metadata();
    expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(1600);
  });

  it('uses a smaller cap for avatars', async () => {
    const sharp = require('sharp');
    const buffer = await sharp({
      create: { width: 2000, height: 2000, channels: 3, background: { r: 5, g: 90, b: 200 } }
    }).png().toBuffer();

    const { file } = await optimizeImage(
      { buffer, mimetype: 'image/png', originalname: 'me.png' },
      { kind: 'avatar' }
    );

    const meta = await sharp(file.buffer).metadata();
    expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(512);
  });

  it('passes videos through untouched', async () => {
    const buffer = Buffer.from('not really a video');
    const { file, optimized } = await optimizeImage(
      { buffer, mimetype: 'video/mp4', originalname: 'clip.mp4' },
      { kind: 'post' }
    );

    expect(optimized).toBe(false);
    expect(file.mimetype).toBe('video/mp4');
    expect(file.buffer).toBe(buffer);
  });

  it('returns the original rather than throwing on a corrupt file', async () => {
    const buffer = Buffer.from('this is not an image at all');
    const { file, optimized } = await optimizeImage(
      { buffer, mimetype: 'image/png', originalname: 'broken.png' },
      { kind: 'post' }
    );

    // A failed post is far worse than an unoptimized one.
    expect(optimized).toBe(false);
    expect(file.buffer).toBe(buffer);
  });

  it('leaves animated gifs alone so they keep animating', async () => {
    const { optimized, reason } = await optimizeImage(
      { buffer: Buffer.from('GIF89a'), mimetype: 'image/gif', originalname: 'a.gif' },
      { kind: 'post' }
    );
    expect(optimized).toBe(false);
    expect(reason).toMatch(/not a still image/);
  });
});

describe('search input escaping (used by the feed sidebar and people search)', () => {
  it('neutralises a filter-injection attempt', () => {
    const evil = 'x,role.eq.admin';
    const safe = escapePostgrestValue(evil);
    expect(safe).not.toContain(',');
    expect(safe).not.toContain('.');
  });
});
