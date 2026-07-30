import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Pull-to-refresh for touch devices.
 *
 * No page in the app could refetch without a full route re-entry. This adds the
 * gesture every phone user already expects.
 *
 * Only engages when the document is already scrolled to the very top, so it
 * never fights normal scrolling.
 */
const THRESHOLD = 72;
const MAX_PULL = 120;

export default function usePullToRefresh(onRefresh, { enabled = true } = {}) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(0);
  const active = useRef(false);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const finish = useCallback(async () => {
    if (pull >= THRESHOLD && !refreshing) {
      setRefreshing(true);
      setPull(THRESHOLD);
      try {
        await onRefreshRef.current?.();
      } finally {
        setRefreshing(false);
        setPull(0);
      }
    } else {
      setPull(0);
    }
    active.current = false;
  }, [pull, refreshing]);

  useEffect(() => {
    if (!enabled) return undefined;
    if (typeof window === 'undefined' || !('ontouchstart' in window)) return undefined;

    const onTouchStart = (e) => {
      if (window.scrollY > 0 || refreshing) return;
      startY.current = e.touches[0].clientY;
      active.current = true;
    };

    const onTouchMove = (e) => {
      if (!active.current || refreshing) return;
      const delta = e.touches[0].clientY - startY.current;
      if (delta <= 0) {
        active.current = false;
        setPull(0);
        return;
      }
      // Resistance curve so the pull feels weighted rather than 1:1
      const resisted = Math.min(MAX_PULL, delta * 0.5);
      setPull(resisted);
    };

    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', finish, { passive: true });
    window.addEventListener('touchcancel', finish, { passive: true });

    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', finish);
      window.removeEventListener('touchcancel', finish);
    };
  }, [enabled, finish, refreshing]);

  return { pull, refreshing, ready: pull >= THRESHOLD };
}

export { usePullToRefresh };
