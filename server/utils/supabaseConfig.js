/**
 * The API runs against Supabase, or it does not start.
 *
 * There used to be a second backend: an in-memory mirror of 59 endpoints
 * (routes/demo.js and db/demoStore.js) that the server fell into whenever the
 * Supabase keys were missing or placeholders, or DEMO_MODE=true. It was
 * removed for two reasons. Two hand-maintained implementations of the same API
 * drift -- every fix had to be made twice, and the mirror was where the copy
 * was forgotten. And falling into it silently was a production incident once:
 * a misnamed key on Vercel booted a healthy-looking, HTTP-200 deployment with
 * no data and a published demo login.
 *
 * So missing or placeholder keys now stop the server in every environment,
 * with a message that says what to set. Local development needs a Supabase
 * project; the free tier is enough (README, "Local setup").
 *
 * Lives in its own module, not index.js, so tests can import the real function
 * rather than a copy -- requiring index.js starts a server.
 */
const { isPlaceholderConfig } = require('../db/supabase');

function assertSupabaseConfig(env = process.env) {
  if (env.DEMO_MODE === 'true' || env.DEMO_MODE === '1') {
    throw new Error(
      'DEMO_MODE was removed: the API now always runs against Supabase. ' +
      'Unset DEMO_MODE and set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY ' +
      '(a free Supabase project is enough; see README, "Local setup").'
    );
  }
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  if (isPlaceholderConfig(url, key)) {
    throw new Error(
      'Refusing to start: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are missing or placeholders. ' +
      'Set them in server/.env (Supabase -> Project Settings -> API).'
    );
  }
}

module.exports = { assertSupabaseConfig };
