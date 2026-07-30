import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import axios from '../services/api';

/**
 * Shared unread-notification count.
 *
 * Navbar and MobileNav both need this. A module-level store keeps them in sync
 * and means one request per route change instead of two.
 */
let current = 0;
const listeners = new Set();
let inFlight = null;

function emit(value) {
  current = value;
  listeners.forEach((fn) => fn(value));
}

export function refreshUnread() {
  // Collapse concurrent callers onto one request
  if (inFlight) return inFlight;
  inFlight = axios
    .get('/api/notifications')
    .then((res) => emit(res.data.unread || 0))
    .catch(() => {})
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Lets a page drop the badge immediately after marking things read. */
export function setUnread(value) {
  emit(Math.max(0, value));
}

/** Bumps the badge without a round trip — used by the realtime subscription. */
export function incrementUnread(by = 1) {
  emit(current + by);
}

export default function useUnreadCount() {
  const [count, setCount] = useState(current);
  const location = useLocation();

  useEffect(() => {
    listeners.add(setCount);
    return () => listeners.delete(setCount);
  }, []);

  // Route-change refresh remains the baseline. It is also the fallback whenever
  // realtime is not configured or the socket drops.
  useEffect(() => {
    refreshUnread();
  }, [location.pathname]);

  return count;
}

export { useUnreadCount };
