import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';
import useReducedMotion from '../../hooks/useReducedMotion';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog on desktop, drag-dismissable bottom sheet on phones.
 *
 * The old `.modal` markup had none of the dialog contract: no role, no
 * aria-modal, no Escape handler, no focus trap, no scroll lock, and it
 * unmounted instantly with no exit animation. This has all of them.
 */
export default function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  labelledBy,
  maxWidth,
  closeOnOverlay = true
}) {
  const panelRef = useRef(null);
  const restoreFocusRef = useRef(null);
  const reduced = useReducedMotion();
  const isMobile =
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;

  useLockBodyScroll(open);

  // Remember what had focus, move focus into the sheet, restore it on close.
  useEffect(() => {
    if (!open) return undefined;
    restoreFocusRef.current = document.activeElement;

    const id = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const first = panel.querySelector(FOCUSABLE);
      (first || panel).focus();
    }, 0);

    return () => {
      window.clearTimeout(id);
      const prev = restoreFocusRef.current;
      if (prev && typeof prev.focus === 'function') prev.focus();
    };
  }, [open]);

  const onKeyDown = useCallback(
    (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
        return;
      }
      if (e.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null
      );
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  if (typeof document === 'undefined') return null;

  const enter = isMobile ? { y: 0 } : { opacity: 1, scale: 1, y: 0 };
  const exit = isMobile ? { y: '100%' } : { opacity: 0, scale: 0.96, y: 8 };
  const initial = isMobile ? { y: '100%' } : { opacity: 0, scale: 0.96, y: 8 };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="sheet-overlay"
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.18 }}
          onMouseDown={(e) => {
            if (closeOnOverlay && e.target === e.currentTarget) onClose?.();
          }}
        >
          <motion.div
            ref={panelRef}
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-label={labelledBy ? undefined : title}
            aria-labelledby={labelledBy}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            style={maxWidth ? { maxWidth } : undefined}
            initial={reduced ? false : initial}
            animate={enter}
            exit={exit}
            transition={
              reduced
                ? { duration: 0 }
                : { type: 'spring', stiffness: 420, damping: 38, mass: 0.9 }
            }
            /* Phone-only: drag the sheet down to dismiss, like a native app */
            drag={isMobile && !reduced ? 'y' : false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 120 || info.velocity.y > 600) onClose?.();
            }}
          >
            <div className="sheet-grabber" aria-hidden="true" />
            {(title || onClose) && (
              <div className="sheet-header">
                {title ? <h2 className="sheet-title">{title}</h2> : <span />}
                {onClose && (
                  <button
                    type="button"
                    className="icon-btn icon-btn--filled"
                    onClick={onClose}
                    aria-label="Close"
                  >
                    <X size={18} />
                  </button>
                )}
              </div>
            )}
            {children}
            {footer}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
