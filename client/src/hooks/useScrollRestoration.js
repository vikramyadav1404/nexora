import { useEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

/**
 * Restores scroll position on back/forward, and scrolls to top on a new push.
 *
 * React Router's <BrowserRouter> does neither by default, so returning to the
 * feed from a profile used to dump you back at the top of page 1 — the single
 * most common way to lose your place in a social app.
 *
 * Positions are keyed by location.key and kept in sessionStorage so they
 * survive a reload but not a new tab.
 */
const KEY = 'nexora_scroll_positions';

function readAll() {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

function writeAll(map) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* quota or private mode — losing scroll position is not worth throwing */
  }
}

export default function useScrollRestoration() {
  const location = useLocation();
  const navigationType = useNavigationType();

  // Save the outgoing position before the route swaps.
  useEffect(() => {
    const key = location.key;
    return () => {
      const map = readAll();
      map[key] = window.scrollY;
      // Keep the map small — only the 30 most recent entries matter
      const entries = Object.entries(map);
      if (entries.length > 30) {
        writeAll(Object.fromEntries(entries.slice(-30)));
      } else {
        writeAll(map);
      }
    };
  }, [location.key]);

  useEffect(() => {
    if (navigationType === 'POP') {
      const saved = readAll()[location.key];
      if (typeof saved === 'number') {
        // Two frames: let the route's first paint commit before we scroll
        requestAnimationFrame(() => {
          requestAnimationFrame(() => window.scrollTo(0, saved));
        });
        return;
      }
    }
    window.scrollTo(0, 0);
  }, [location.key, navigationType]);
}

export { useScrollRestoration };
