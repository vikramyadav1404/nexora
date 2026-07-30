import { useEffect, useState } from 'react';

/**
 * Tracks the OS "reduce motion" setting.
 *
 * The CSS in index.css already neutralises declarative animation, but
 * JS-driven motion (springs, drag, AnimatePresence) has to opt out itself.
 * Gate every such animation on this.
 */
export default function useReducedMotion() {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

export { useReducedMotion };
