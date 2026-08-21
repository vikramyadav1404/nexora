import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Fetch something, and always say which of three things happened.
 *
 * Seven pages wrote their own version of this and six of them collapsed two
 * different facts into one. The shape was always:
 *
 *     const [items, setItems] = useState([]);
 *     const [loading, setLoading] = useState(true);
 *     try { setItems(await get()) } catch {} finally { setLoading(false) }
 *
 * A failed request leaves `items` empty and `loading` false, which renders
 * exactly like a successful request that found nothing. So the user is told
 * "No transactions yet" when the truth is "we could not reach the server", and
 * SpaceDetail went further and rendered "Space not found" -- the UI asserting
 * something does not exist because the network hiccuped.
 *
 * Three pages did it correctly, with a separate loadError flag. Nothing
 * generalised them, so each page had to remember the middle branch and six
 * forgot. This is that generalisation: status is one of 'loading' | 'error' |
 * 'ready', and there is no way to be given data without also being given the
 * status that produced it.
 *
 * Pair it with <AsyncState>, which is what actually makes the mistake
 * unavailable -- a hook can be ignored, a component that owns the branches
 * cannot.
 *
 * @param {(signal: AbortSignal) => Promise<any>} fetcher
 * @param {any[]} deps - re-fetch when these change, as useEffect
 * @param {{ enabled?: boolean, initialData?: any }} [options]
 */
export default function useResource(fetcher, deps = [], options = {}) {
  const { enabled = true, initialData = null } = options;

  const [state, setState] = useState({
    status: enabled ? 'loading' : 'ready',
    data: initialData,
    error: null
  });

  /*
   * The fetcher is almost always an inline arrow, so it is a new function on
   * every render. Depending on it directly would refetch forever; holding it in
   * a ref and depending on the caller's `deps` is what keeps the contract the
   * same as useEffect's.
   */
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Bumped per request so a slow earlier response cannot overwrite a newer one.
  const runIdRef = useRef(0);
  const abortRef = useRef(null);

  const load = useCallback(async () => {
    if (!enabled) {
      /*
       * Disabled is a resting state, not a frozen one. Search sets enabled
       * false for queries under two characters -- so without this, running a
       * search that errors and then clearing the box left the error on screen
       * with nothing to explain it.
       */
      abortRef.current?.abort();
      runIdRef.current += 1;
      setState((prev) => ({ status: 'ready', data: prev.data, error: null }));
      return;
    }

    const runId = ++runIdRef.current;

    // Cancel whatever is in flight. There was no AbortController anywhere in
    // this client, so every page raced its own responses: change a filter
    // quickly and the older request could land last and win.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState((prev) => ({ status: 'loading', data: prev.data, error: null }));

    try {
      const data = await fetcherRef.current(controller.signal);
      if (runId !== runIdRef.current) return; // superseded
      setState({ status: 'ready', data, error: null });
    } catch (err) {
      if (runId !== runIdRef.current) return;
      // An abort is not a failure -- it means we deliberately moved on, and
      // showing an error for it would flash a broken state during navigation.
      if (err?.name === 'AbortError' || err?.code === 'ERR_CANCELED') return;
      setState({ status: 'error', data: null, error: err });
    }
  }, [enabled]);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, ...deps]);

  return {
    status: state.status,
    data: state.data,
    error: state.error,
    isLoading: state.status === 'loading',
    isError: state.status === 'error',
    reload: load,
    /** Local edits without a refetch — e.g. removing a row after a delete. */
    setData: useCallback((updater) => {
      setState((prev) => ({
        ...prev,
        data: typeof updater === 'function' ? updater(prev.data) : updater
      }));
    }, [])
  };
}
