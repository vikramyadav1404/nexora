import { useCallback, useRef, useState } from 'react';

/**
 * Optimistic list mutations with automatic rollback.
 *
 * Every mutation in the app used to await the server before the UI moved, so
 * tapping Like felt like a form submit. These helpers apply the change locally
 * first, then reconcile — or restore the previous state if the request fails.
 *
 * Deliberately small: this app has no data-fetching library and adding one
 * would be a much larger change than the interaction problem warrants.
 */

/**
 * Wraps a setState for a list of items keyed by `_id`/`id`.
 *
 *   const { patch, run } = useOptimisticList(setPosts);
 *   run({
 *     id: post._id,
 *     optimistic: { liked: true, likeCount: n + 1 },
 *     request: () => axios.post(`/api/posts/${post._id}/like`),
 *     commit: (res) => ({ likeCount: res.data.likes, liked: res.data.liked }),
 *     onError: () => toast.error('Could not like that'),
 *   });
 */
export function useOptimisticList(setItems) {
  // Requests in flight, so a double-tap cannot fire the same mutation twice
  const inFlight = useRef(new Set());

  const idOf = (item) => item?._id ?? item?.id;

  const patch = useCallback(
    (id, changes) => {
      setItems((prev) =>
        prev.map((item) =>
          idOf(item) === id
            ? { ...item, ...(typeof changes === 'function' ? changes(item) : changes) }
            : item
        )
      );
    },
    [setItems]
  );

  const run = useCallback(
    async ({ id, optimistic, request, commit, onError, dedupe = true }) => {
      if (dedupe && inFlight.current.has(id)) return undefined;
      if (dedupe) inFlight.current.add(id);

      // Snapshot only the row we touch, so a concurrent refetch is not clobbered
      let snapshot = null;
      setItems((prev) => {
        const found = prev.find((item) => idOf(item) === id);
        if (found) snapshot = found;
        return prev;
      });

      if (optimistic) patch(id, optimistic);

      try {
        const res = await request();
        if (commit) patch(id, commit(res));
        return res;
      } catch (err) {
        if (snapshot) {
          setItems((prev) => prev.map((item) => (idOf(item) === id ? snapshot : item)));
        }
        onError?.(err);
        return undefined;
      } finally {
        inFlight.current.delete(id);
      }
    },
    [patch, setItems]
  );

  const isPending = useCallback((id) => inFlight.current.has(id), []);

  return { patch, run, isPending };
}

/**
 * Optimistic toggle for a single boolean+count pair (votes, follows, saves).
 * Returns [state, toggle, pending].
 */
export function useOptimisticToggle(initialActive, initialCount, request) {
  const [active, setActive] = useState(!!initialActive);
  const [count, setCount] = useState(initialCount ?? 0);
  const [pending, setPending] = useState(false);

  const toggle = useCallback(async () => {
    if (pending) return;
    const prevActive = active;
    const prevCount = count;

    setActive(!prevActive);
    setCount(prevCount + (prevActive ? -1 : 1));
    setPending(true);

    try {
      const res = await request(!prevActive);
      if (res && typeof res.count === 'number') setCount(res.count);
      if (res && typeof res.active === 'boolean') setActive(res.active);
    } catch {
      setActive(prevActive);
      setCount(prevCount);
    } finally {
      setPending(false);
    }
  }, [active, count, pending, request]);

  return [{ active, count }, toggle, pending];
}

export default useOptimisticList;
