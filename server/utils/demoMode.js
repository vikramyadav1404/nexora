/**
 * Deciding whether to run against the real database or the in-memory demo.
 *
 * This lives in its own module rather than inside index.js so it can be tested
 * directly. Requiring index.js from a test starts a server and mounts every
 * route; the first version of these tests reimplemented the logic instead,
 * which meant they asserted against a copy and would not have noticed the real
 * function changing.
 */

function isPlaceholderConfig(url, key) {
  if (!url || !key) return true;
  const bad = ['YOUR_PROJECT_REF', 'your_service_role_key', 'your_service_role_key_here', 'xxxxxxxx'];
  return bad.some(b => url.includes(b) || key.includes(b));
}

/**
 * Falling back to demo mode is a development convenience and a production
 * incident.
 *
 * The demo backend is an in-memory store that loses everything on a cold start,
 * and it publishes a working login (demo@nexora.com / demo1234) on an
 * unauthenticated health endpoint. Falling into it silently meant a misnamed or
 * missing SUPABASE_SERVICE_ROLE_KEY on Vercel produced a running, HTTP-200,
 * apparently-healthy deployment that anyone on the internet could log into --
 * and an explicit DEMO_MODE=false did not prevent it, because the placeholder
 * check overrode it.
 *
 * So in production the fallback throws instead. Crashing is the correct
 * outcome: a failed deploy is visible, where the previous console.warn was not.
 *
 * An explicit DEMO_MODE=true still works anywhere, including production -- that
 * is someone deliberately deploying a demo, which is a different thing from a
 * misconfigured real deployment quietly becoming one. Same reasoning as
 * ALLOW_MOCK_PAYMENTS in routes/subscriptions.js.
 */
function shouldUseDemoMode(env = process.env) {
  // Explicit opt-in, honoured everywhere. Typed out on purpose.
  if (env.DEMO_MODE === 'true' || env.DEMO_MODE === '1') return true;

  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  const placeholder = isPlaceholderConfig(url, key);

  const refuse = (reason) => {
    if (env.NODE_ENV !== 'production') return;
    throw new Error(
      `Refusing to start in demo mode in production: ${reason}. ` +
      'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or set DEMO_MODE=true to run a demo deliberately.'
    );
  };

  if (env.DEMO_MODE === 'false' || env.DEMO_MODE === '0') {
    if (placeholder) {
      refuse('DEMO_MODE=false but the Supabase keys are missing or placeholders');
      console.warn('DEMO_MODE=false but Supabase keys missing/placeholder → using DEMO until keys are set.');
      return true;
    }
    return false;
  }

  if (placeholder) {
    refuse('the Supabase keys are missing or placeholders');
    return true;
  }
  return false;
}

/**
 * Whether the demo login may be published on /api/health.
 *
 * Handing out working credentials on an unauthenticated endpoint is fine for a
 * local demo and not fine on a public host, so it is withheld in production
 * even when the demo was started deliberately.
 */
function mayPublishDemoLogin(env = process.env) {
  return env.NODE_ENV !== 'production';
}

module.exports = { shouldUseDemoMode, isPlaceholderConfig, mayPublishDemoLogin };
