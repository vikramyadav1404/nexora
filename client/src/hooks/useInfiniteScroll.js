import { useEffect, useRef } from 'react';

/**
 * Fires `onLoadMore` when a sentinel scrolls into view.
 *
 * Attach the returned ref to an element placed after the last list item.
 * `rootMargin` pre-fetches before the sentinel is actually visible, so the
 * next page is usually already in place by the time the user reaches it.
 *
 *   const sentinel = useInfiniteScroll({ hasMore, loading, onLoadMore: next });
 *   ...
 *   <div ref={sentinel} className="feed-sentinel" />
 */
export default function useInfiniteScroll({
  hasMore,
  loading,
  onLoadMore,
  rootMargin = '600px'
}) {
  const sentinelRef = useRef(null);
  // Keep the callback fresh without re-creating the observer every render
  const handlerRef = useRef(onLoadMore);
  handlerRef.current = onLoadMore;

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading) return undefined;
    if (typeof IntersectionObserver === 'undefined') return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) handlerRef.current?.();
      },
      { rootMargin }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loading, rootMargin]);

  return sentinelRef;
}

export { useInfiniteScroll };
