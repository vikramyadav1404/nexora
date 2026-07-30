import { useState } from 'react';
import { ImageOff } from 'lucide-react';
import { mediaUrl } from '../../utils/mediaUrl';

/**
 * The only <img> the app should render.
 *
 * Every raw <img> before this had no lazy-loading, no intrinsic size and no
 * error handling, so each post shifted the page as it loaded and a dead URL
 * left a broken-image glyph. This reserves space via `ratio`, defers offscreen
 * decodes, and fades in once decoded.
 *
 * Pass `ratio` (e.g. 4/5) whenever the box should be reserved. Omit it only
 * when the parent already constrains height.
 */
export default function SmartImage({
  src,
  alt = '',
  ratio,
  contain = false,
  eager = false,
  className = '',
  imgClassName = '',
  style,
  onClick,
  ...rest
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const resolved = mediaUrl(src);

  return (
    <div
      className={`smart-img ${loaded ? 'is-loaded' : ''} ${contain ? 'is-contain' : ''} ${className}`.trim()}
      style={{ aspectRatio: ratio || undefined, ...style }}
      onClick={onClick}
    >
      {!failed && (
        <img
          src={resolved}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          fetchPriority={eager ? 'high' : 'auto'}
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={imgClassName}
          {...rest}
        />
      )}
      {failed && (
        <div className="smart-img-fallback">
          <ImageOff size={22} strokeWidth={1.75} aria-label={alt || 'Image unavailable'} />
        </div>
      )}
    </div>
  );
}
