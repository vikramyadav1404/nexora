// uploads go to supabase storage when USE_SUPABASE_STORAGE=true, otherwise disk
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

async function uploadMedia(file, { bucket = 'posts', folder = '' } = {}) {
  if (!file) throw new Error('No file provided');

  const ext = path.extname(file.originalname || file.filename || '').toLowerCase() || '.bin';
  const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.pdf'];
  const safeExt = allowed.includes(ext) ? ext : '.bin';
  const objectPath = `${folder ? folder + '/' : ''}${Date.now()}-${Math.random().toString(36).slice(2, 10)}${safeExt}`;

  if (useCloudStorage()) {
    const db = getSupabase();
    let buffer;
    if (file.buffer) buffer = file.buffer;
    else if (file.path) buffer = fs.readFileSync(file.path);
    else throw new Error('Upload file has no buffer or path');

    const { error } = await db.storage.from(bucket).upload(objectPath, buffer, {
      contentType: file.mimetype || 'application/octet-stream',
      upsert: false
    });

    if (file.path && fs.existsSync(file.path)) {
      try { fs.unlinkSync(file.path); } catch { /* temp cleanup */ }
    }

    if (error) {
      console.error('storage upload failed:', error.message);
      // fall back to local disk if we still have the bytes
      if (file.buffer) {
        const localDir = path.join(__dirname, '..', 'uploads', bucket);
        if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
        const localName = path.basename(objectPath);
        fs.writeFileSync(path.join(localDir, localName), file.buffer);
        return { url: `/uploads/${bucket}/${localName}`, storage: 'local' };
      }
      throw error;
    }

    return { url: publicUrlForPath(bucket, objectPath), storage: 'supabase' };
  }

  // local disk (dev) — multer memory buffer or already-on-disk file
  const sub = bucket === 'avatars' ? 'avatars' : 'posts';
  const localDir = path.join(__dirname, '..', 'uploads', sub);
  if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });

  if (file.buffer) {
    const localName = path.basename(objectPath);
    fs.writeFileSync(path.join(localDir, localName), file.buffer);
    return { url: `/uploads/${sub}/${localName}`, storage: 'local' };
  }
  if (file.filename) {
    return { url: `/uploads/${sub}/${file.filename}`, storage: 'local' };
  }
  if (file.path) {
    return { url: `/uploads/${sub}/${path.basename(file.path)}`, storage: 'local' };
  }
  throw new Error('Cannot resolve local upload path');
}

async function ensureBuckets() {
  if (!useCloudStorage()) return { skipped: true };
  const db = getSupabase();
  const results = {};
  for (const name of ['avatars', 'posts']) {
    const { data: existing } = await db.storage.getBucket(name);
    if (existing) {
      results[name] = 'exists';
      continue;
    }
    const { error } = await db.storage.createBucket(name, {
      public: true,
      fileSizeLimit: 50 * 1024 * 1024
    });
    results[name] = error ? error.message : 'created';
  }
  return results;
}

module.exports = { uploadMedia, ensureBuckets, useCloudStorage, publicUrlForPath };
