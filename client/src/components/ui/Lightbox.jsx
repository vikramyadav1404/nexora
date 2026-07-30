import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { mediaUrl } from '../../utils/mediaUrl';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';
import useReducedMotion from '../../hooks/useReducedMotion';

/**
 * Fullscreen media viewer.
 *
 * `items` is the post's media array: [{ type: 'image' | 'video', url }].
 * Arrow keys and Escape work on desktop; on touch you swipe sideways to
 * change item and drag down to dismiss.
 */
export default function Lightbox({ items = [], index = 0, open, onClose }) {
  const [current, setCurrent] = useState(index);
  const reduced = useReducedMotion();

  useLockBodyScroll(open);
  useEffect(() => setCurrent(index), [index, open]);

  const count = items.length;
  const go = useCallback(
    (delta) => setCurrent((c) => (c + delta + count) % count),
    [count]
  );

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
      else if (e.key === 'ArrowRight' && count > 1) go(1);
      else if (e.key === 'ArrowLeft' && count > 1) go(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, go, count]);

  if (typeof document === 'undefined' || !count) return null;
  const item = items[current];

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Media viewer"
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.2 }}
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose?.();
          }}
        >
          <button type="button" className="lightbox-close" onClick={onClose} aria-label="Close viewer">
            <X size={20} />
          </button>

          {count > 1 && (
            <>
              <button
                type="button"
                className="lightbox-nav prev"
                onClick={() => go(-1)}
                aria-label="Previous"
              >
                <ChevronLeft size={22} />
              </button>
              <button
                type="button"
                className="lightbox-nav next"
                onClick={() => go(1)}
                aria-label="Next"
              >
                <ChevronRight size={22} />
              </button>
            </>
          )}

          <motion.div
            key={current}
            className="lightbox-stage"
            initial={reduced ? false : { opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={
              reduced ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 34 }
            }
            drag={reduced ? false : true}
            dragConstraints={{ left: 0, right: 0, top: 0, bottom: 0 }}
            dragElastic={0.35}
            onDragEnd={(_, info) => {
              // Down = dismiss; sideways = change item
              if (info.offset.y > 140 && Math.abs(info.offset.y) > Math.abs(info.offset.x)) {
                onClose?.();
              } else if (count > 1 && Math.abs(info.offset.x) > 90) {
                go(info.offset.x < 0 ? 1 : -1);
              }
            }}
          >
            {item.type === 'video' ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video src={mediaUrl(item.url)} controls autoPlay playsInline />
            ) : (
              <img src={mediaUrl(item.url)} alt={item.alt || 'Post media'} draggable={false} />
            )}
          </motion.div>

          {count > 1 && (
            <div className="lightbox-counter">
              {current + 1} / {count}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
