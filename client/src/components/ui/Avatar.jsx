import { mediaUrl } from '../../utils/mediaUrl';
import { useMediaFallback } from '../../hooks/useMediaFallback';

/**
 * Stable hue for a user, so the same person is always the same colour.
 *
 * Seeded from the user id rather than the name: names change, and two people
 * called "Alex" should not be indistinguishable in a comment thread. Falls back
 * to the name when no id is available (search results, seeded authors).
 *
 * djb2 — short, no dependency, and well spread across the hue circle.
 */
function hueFrom(seed) {
  const str = String(seed || '');
  let hash = 5381;
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/**
 * Avatar with an initial-letter fallback.
 *
 * Every avatar site previously rendered a raw <img> with no onError, so a
 * missing upload showed the browser's broken-image icon. Here a failed or
 * absent src degrades to a coloured initial instead.
 */
export default function Avatar({
  src,
  name = '',
  userId = '',
  size = 40,
  ring = false,
  className = '',
  style,
  ...rest
}) {
  const resolved = src ? mediaUrl(src) : '';
  // A 401 on our own media means a missing cookie, not a missing file, so this
  // retries once before degrading to the initial.
  const { src: imgSrc, failed, onError } = useMediaFallback(resolved);
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  const hue = hueFrom(userId || name);

  const ringStyle = ring
    ? { boxShadow: '0 0 0 2px var(--bg-surface), 0 0 0 4px var(--nx-violet)' }
    : undefined;

  if (!resolved || failed) {
    return (
      <div
        className={`avatar-placeholder ${className}`.trim()}
        style={{
          width: size,
          height: size,
          fontSize: Math.max(11, Math.round(size * 0.38)),
          // Two stops of the same hue so the placeholder reads as a designed
          // shape rather than a flat grey square.
          background: `linear-gradient(135deg, hsl(${hue} 62% 52%), hsl(${(hue + 28) % 360} 62% 44%))`,
          color: '#fff',
          ...ringStyle,
          ...style
        }}
        aria-label={name || 'User'}
        {...rest}
      >
        {initial}
      </div>
    );
  }

  return (
    <img
      className={`avatar ${className}`.trim()}
      src={imgSrc}
      alt={name || 'User'}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={onError}
      style={{ width: size, height: size, ...ringStyle, ...style }}
      {...rest}
    />
  );
}
