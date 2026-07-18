/**
 * Media storage: Supabase Storage when configured, else local /uploads.
 * Buckets expected: avatars, posts (public read).
 */
const path = require('path');
const fs = require('fs');
const { getSupabase } = require('../db/supabase');

function useCloudStorage() {
  return process.env.USE_SUPABASE_STORAGE === 'true' || process.env.USE_SUPABASE_STORAGE === '1';
}

function publicUrlForPath(bucket, objectPath) {
  const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  return `${base}/storage/v1/object/public/${bucket}/${objectPath}`;
}

/**
 * Upload a multer file (disk or memory) to Supabase Storage or return local path.
 * @returns {{ url: string, storage: 'supabase'|'local' }}
 */
async function uploadMedia(file, { bucket = 'posts', folder = '' } = {}) {
  if (!file) throw new Error('No file provided');

  const ext = path.extname(file.originalname || file.filename || '').toLowerCase() || '.bin';
  const safeExt = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.pdf'].includes(ext)
    ? ext
    : '.bin';
  const objectPath = `${folder ? `${folder}/` : ''}${Date.now()}-${Math.random().toString(36).slice(2, 10)}${safeExt}`;

  if (useCloudStorage()) {
    const db = getSupabase();
    let buffer;
    if (file.buffer) {
      buffer = file.buffer;
    } else if (file.path) {
      buffer = fs.readFileSync(file.path);
    } else {
      throw new Error('Upload file has no buffer or path');
    }

    const { error } = await db.storage.from(bucket).upload(objectPath, buffer, {
      contentType: file.mimetype || 'application/octet-stream',
      upsert: false
    });

    // Clean local temp if disk storage was used
    if (file.path && fs.existsSync(file.path)) {
      try { fs.unlinkSync(file.path); } catch { /* ignore */ }
    }

    if (error) {
      console.error('Supabase storage upload failed:', error.message);
      // Fall back to local if we still have path (re-write)
      if (file.buffer) {
        const localDir = path.join(__dirname, '..', 'uploads', bucket);
        if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
        const localName = path.basename(objectPath);
        const localFull = path.join(localDir, localName);
        fs.writeFileSync(localFull, file.buffer);
        return { url: `/uploads/${bucket}/${localName}`, storage: 'local' };
      }
      throw error;
    }

    return { url: publicUrlForPath(bucket, objectPath), storage: 'supabase' };
  }

  // Local disk (default / already saved by multer diskStorage)
  if (file.filename) {
    const sub = bucket === 'avatars' ? 'avatars' : 'posts';
    return { url: `/uploads/${sub}/${file.filename}`, storage: 'local' };
  }
  if (file.path) {
    const sub = bucket === 'avatars' ? 'avatars' : 'posts';
    const name = path.basename(file.path);
    return { url: `/uploads/${sub}/${name}`, storage: 'local' };
  }
  throw new Error('Cannot resolve local upload path');
}

async function ensureBuckets() {
  if (!useCloudStorage()) return { skipped: true };
  const db = getSupabase();
  const buckets = ['avatars', 'posts'];
  const results = {};
  for (const name of buckets) {
    const { data: existing } = await db.storage.getBucket(name);
    if (existing) {
      results[name] = 'exists';
      continue;
    }
    const { error } = await db.storage.createBucket(name, { public: true, fileSizeLimit: 50 * 1024 * 1024 });
    results[name] = error ? error.message : 'created';
  }
  return results;
}

module.exports = { uploadMedia, ensureBuckets, useCloudStorage, publicUrlForPath };
