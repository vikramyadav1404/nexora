import { useEffect } from 'react';

/**
 * Sets document.title for SEO / tab UX.
 * @param {string} title - page title (appended with " · Nexora")
 */
export function usePageTitle(title) {
  useEffect(() => {
    const prev = document.title;
    document.title = title ? `${title} · Nexora` : 'Nexora';
    return () => {
      document.title = prev;
    };
  }, [title]);
}

export default usePageTitle;
