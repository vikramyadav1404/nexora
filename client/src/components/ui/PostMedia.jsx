import { useCallback, useEffect, useRef, useState } from 'react';
import useEmblaCarousel from 'embla-carousel-react';
import { AnimatePresence, motion } from 'motion/react';
import { Heart } from 'lucide-react';
import SmartImage from './SmartImage';
import Lightbox from './Lightbox';
import { mediaUrl } from '../../utils/mediaUrl';
import useReducedMotion from '../../hooks/useReducedMotion';

/**
 * The media block inside a post card.
 *
 * Previously multiple images just stacked vertically full-width with no viewer
 * and no lazy-loading. Now: one image renders alone, several become a swipeable
 * carousel with dots, any of them opens a fullscreen Lightbox, and a double-tap
 * anywhere fires `onDoubleTapLike`.
 */
export default function PostMedia({ media = [], onDoubleTapLike }) {
  const [emblaRef, embla] = useEmblaCarousel({ loop: false, align: 'start' });
  const [selected, setSelected] = useState(0);
  const [lightboxAt, setLightboxAt] = useState(-1);
  const [burstKey, setBurstKey] = useState(0);
  const lastTapRef = useRef(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (!embla) return undefined;
    const onSelect = () => setSelected(embla.selectedScrollSnap());
    embla.on('select', onSelect);
    onSelect();
    return () => {
      embla.off('select', onSelect);
    };
  }, [embla]);

  // A pointer double-tap likes the post and shows the heart burst.
  const handlePointerUp = useCallback(
    (e, idx) => {
      const now = Date.now();
      if (now - lastTapRef.current < 300) {
        lastTapRef.current = 0;
        if (onDoubleTapLike) {
          onDoubleTapLike();
          setBurstKey((k) => k + 1);
        }
        return;
      }
      lastTapRef.current = now;
      // Single tap opens the viewer, but only after the double-tap window closes
      const target = e.currentTarget;
      window.setTimeout(() => {
        if (lastTapRef.current && target.isConnected) setLightboxAt(idx);
      }, 300);
    },
    [onDoubleTapLike]
  );

  if (!media.length) return null;

  const ratio = media.length > 1 ? 4 / 5 : undefined;

  const renderItem = (m, i) => (
    <div
      className="post-media post-media--tappable"
      style={{ margin: media.length > 1 ? 0 : undefined }}
      onPointerUp={(e) => handlePointerUp(e, i)}
      role="button"
      tabIndex={0}
      aria-label="Open media"
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setLightboxAt(i);
        }
      }}
    >
      {m.type === 'video' ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          src={mediaUrl(m.url)}
          controls
          playsInline
          preload="metadata"
          style={{ width: '100%', display: 'block' }}
        />
      ) : (
        <SmartImage src={m.url} alt="Post media" ratio={ratio} contain={media.length === 1} />
      )}

      {/* Heart burst — only ever rendered on the visible slide */}
      <AnimatePresence>
        {burstKey > 0 && i === selected && !reduced && (
          <motion.div
            key={burstKey}
            className="heart-burst"
            initial={{ scale: 0.2, opacity: 0, x: '-50%', y: '-50%' }}
            animate={{ scale: [0.2, 1.15, 1], opacity: [0, 1, 1] }}
            exit={{ scale: 1.4, opacity: 0 }}
            transition={{ duration: 0.5, times: [0, 0.45, 1], ease: [0.16, 1, 0.3, 1] }}
            onAnimationComplete={() => setBurstKey(0)}
          >
            <Heart size={92} fill="currentColor" strokeWidth={0} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  return (
    <>
      {media.length === 1 ? (
        renderItem(media[0], 0)
      ) : (
        <div className="carousel" style={{ marginBottom: 'var(--space-3)' }}>
          <div className="carousel-viewport" ref={emblaRef}>
            <div className="carousel-track">
              {media.map((m, i) => (
                <div className="carousel-slide" key={i}>
                  {renderItem(m, i)}
                </div>
              ))}
            </div>
          </div>

          <div className="carousel-counter">
            {selected + 1}/{media.length}
          </div>

          <div className="carousel-dots" role="tablist" aria-label="Media">
            {media.map((_, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === selected}
                aria-label={`Go to item ${i + 1}`}
                className={`carousel-dot ${i === selected ? 'active' : ''}`}
                onClick={() => embla?.scrollTo(i)}
              />
            ))}
          </div>
        </div>
      )}

      <Lightbox
        items={media}
        index={Math.max(0, lightboxAt)}
        open={lightboxAt >= 0}
        onClose={() => setLightboxAt(-1)}
      />
    </>
  );
}
