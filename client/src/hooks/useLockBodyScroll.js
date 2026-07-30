import { useEffect } from 'react';

/**
 * Prevents the page behind an overlay from scrolling.
 *
 * Compensates for the disappearing scrollbar so the layout does not jump
 * sideways when a sheet opens on desktop.
 */
export default function useLockBodyScroll(locked = true) {
  useEffect(() => {
    if (!locked) return undefined;

    const { body } = document;
    const prevOverflow = body.style.overflow;
    const prevPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

    body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      const current = parseFloat(window.getComputedStyle(body).paddingRight) || 0;
      body.style.paddingRight = `${current + scrollbarWidth}px`;
    }

    return () => {
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPaddingRight;
    };
  }, [locked]);
}

export { useLockBodyScroll };
