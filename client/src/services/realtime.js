import axios from './api';

/**
 * Live notifications over Supabase Realtime.
 *
 * The unread badge previously only refreshed when the route changed, so a
 * notification arriving while you sat on a page stayed invisible.
 *
 * Auth note: Nexora signs its own session JWTs, which Supabase cannot verify.
 * The server mints a separate short-lived Supabase-compatible token at
 * /api/auth/realtime-token; that is what authenticates this socket, and the
 * RLS policy from migration 007 scopes the stream to the caller's own rows.
 *
 * Everything here degrades quietly: if the env vars are missing or the socket
 * cannot connect, the app keeps working with route-change refresh as before.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

let client = null;
let channel = null;
let refreshTimer = null;

export function isRealtimeConfigured() {
  return !!(SUPABASE_URL && SUPABASE_ANON_KEY);
}

async function fetchRealtimeToken() {
  const res = await axios.get('/api/auth/realtime-token');
  return res.data;
}

/**
 * Subscribe to the current user's notifications.
 *
 * @param {string} userId
 * @param {(notification: object) => void} onInsert
 * @returns {() => void} unsubscribe
 */
export async function subscribeToNotifications(userId, onInsert) {
  if (!isRealtimeConfigured() || !userId) return () => {};

  try {
    const { token, expiresIn } = await fetchRealtimeToken();

    // Loaded on demand, not at module scope. supabase-js is ~340KB and this is
    // an optional enhancement needed only after login — importing it eagerly
    // put it in the main bundle and delayed first paint for everyone.
    const { createClient } = await import('@supabase/supabase-js');

    client ||= createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 5 } }
    });

    client.realtime.setAuth(token);

    channel = client
      .channel(`notifications:${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`
        },
        (payload) => {
          if (payload?.new) onInsert(payload.new);
        }
      )
      .subscribe();

    // The token is short-lived; refresh a minute before it lapses so a long
    // session doesn't silently stop receiving events.
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      fetchRealtimeToken()
        .then(({ token: next }) => client?.realtime.setAuth(next))
        .catch(() => {});
    }, Math.max(30_000, (expiresIn - 60) * 1000));

    return unsubscribe;
  } catch {
    // Realtime is an enhancement — route-change refresh still covers us.
    return () => {};
  }
}

export function unsubscribe() {
  clearTimeout(refreshTimer);
  refreshTimer = null;
  if (channel && client) {
    client.removeChannel(channel);
    channel = null;
  }
}
