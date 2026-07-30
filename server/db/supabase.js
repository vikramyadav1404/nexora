const { createClient } = require('@supabase/supabase-js');

let supabase = null;

function isPlaceholderConfig(url, key) {
  if (!url || !key) return true;
  const bad = ['YOUR_PROJECT_REF', 'your_service_role_key', 'your_service_role_key_here', 'xxxxxxxx'];
  return bad.some((b) => url.includes(b) || key.includes(b));
}

function getSupabase() {
  if (supabase) return supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in server/.env');
  }
  if (isPlaceholderConfig(url, key)) {
    throw new Error('Supabase keys still look like placeholders — paste real ones in server/.env');
  }

  supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  return supabase;
}

/**
 * Test-only seam.
 *
 * The route modules are CommonJS and reach this file through nested
 * `require()` calls, which Vitest's module mocking cannot intercept — mocking
 * `db/supabase` only replaces it for direct importers, so a router still gets
 * the real client. Because `getSupabase()` memoizes into the module-level
 * `supabase`, setting it here swaps the client for every consumer at once.
 *
 * Only ever called from server/test/**. Pass null to restore normal behaviour.
 */
function __setTestClient(client) {
  supabase = client;
}

module.exports = { getSupabase, isPlaceholderConfig, __setTestClient };
