#!/usr/bin/env node
/**
 * Assert no storage bucket is publicly readable.
 *
 * This is the probe that found the flaw, kept as a check so it cannot come
 * back: fetch an object's public URL with no credentials at all and fail if it
 * returns 200. On the live project that returned 200 for a real user's avatar.
 *
 * It exists separately from the test suite because it checks something the
 * suite structurally cannot see. Bucket visibility is Supabase state, not code:
 * someone can flip a bucket back to public in the dashboard and every unit test
 * still passes, because no code changed. Only a live request can tell.
 *
 * Two layers, deliberately:
 *   - the bucket's own `public` flag, read from the API
 *   - an actual unauthenticated GET, because the flag is what Supabase says and
 *     the GET is what an attacker gets. If those ever disagree, the GET wins.
 *
 * Run from `npm run check:buckets`, and after any deploy that touches storage.
 */
require('dotenv').config();

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const auth = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

async function main() {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, { headers: auth });
  if (!res.ok) {
    console.error(`Could not list buckets (HTTP ${res.status}).`);
    process.exit(1);
  }
  const buckets = await res.json();
  const problems = [];

  for (const bucket of buckets) {
    if (bucket.public) {
      problems.push(`bucket "${bucket.name}" is marked public`);
    }

    // One real object, fetched with no credentials. The flag says what Supabase
    // intends; this says what the internet actually gets.
    const listed = await fetch(
      `${SUPABASE_URL}/storage/v1/object/list/${bucket.name}`,
      {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 1, prefix: '' })
      }
    );

    let sample = null;
    if (listed.ok) {
      const rows = await listed.json();
      // Top level is usually a folder; walk one level in to reach an object.
      if (rows[0]?.name) {
        const inner = await fetch(
          `${SUPABASE_URL}/storage/v1/object/list/${bucket.name}`,
          {
            method: 'POST',
            headers: { ...auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ limit: 1, prefix: rows[0].name })
          }
        );
        if (inner.ok) {
          const innerRows = await inner.json();
          if (innerRows[0]?.id) sample = `${rows[0].name}/${innerRows[0].name}`;
        }
        if (!sample && rows[0].id) sample = rows[0].name;
      }
    }

    if (!sample) {
      console.log(`  ${bucket.name.padEnd(10)} public=${bucket.public}  (no object to probe)`);
      continue;
    }

    const anon = await fetch(
      `${SUPABASE_URL}/storage/v1/object/public/${bucket.name}/${sample}`
    );
    const readable = anon.status === 200;
    if (readable) {
      problems.push(
        `bucket "${bucket.name}" served ${sample} to an unauthenticated request (HTTP 200)`
      );
    }
    console.log(
      `  ${bucket.name.padEnd(10)} public=${bucket.public}  unauthenticated GET -> ${anon.status}`
    );
  }

  if (problems.length) {
    console.error('\nStorage is publicly readable:\n');
    for (const p of problems) console.error('  ' + p);
    console.error(
      '\nEvery object in a public bucket is readable by anyone holding the URL,\n' +
      'forever, regardless of the post it belongs to and after the account is\n' +
      'deleted. Media is served through /api/media, which authorises first.\n'
    );
    process.exit(1);
  }

  console.log('\nbucket check: nothing is publicly readable');
}

main().catch((err) => {
  console.error('bucket check failed to run:', err.message);
  process.exit(1);
});
