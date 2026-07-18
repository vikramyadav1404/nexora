const { createClient } = require('@supabase/supabase-js');

let supabase = null;

function isPlaceholderConfig(url, key) {
  if (!url || !key) return true;
  const bad = [
    'YOUR_PROJECT_REF',
    'your_service_role_key',
    'your_service_role_key_here',
    'xxxxxxxx'
  ];
  return bad.some(b => url.includes(b) || key.includes(b));
}

function getSupabase() {
  if (supabase) return supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      'Missing Supabase config. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in server/.env'
    );
  }

  if (isPlaceholderConfig(url, key)) {
    throw new Error(
      'Supabase is not configured. Replace SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in server/.env with your real project values from Supabase → Project Settings → API.'
    );
  }

  supabase = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });

  return supabase;
}

module.exports = { getSupabase, isPlaceholderConfig };
