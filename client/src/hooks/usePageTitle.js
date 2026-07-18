import { useEffect } from 'react';

// small helper so browser tabs don't all say just "Nexora"
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
