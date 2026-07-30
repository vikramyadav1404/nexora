import { useState } from 'react';
import { mediaUrl } from '../../utils/mediaUrl';

/**
 * Avatar with an initial-letter fallback.
 *
 * Every avatar site previously rendered a raw <img> with no onError, so a
 * missing upload showed the browser's broken-image icon. Here a failed or
 * absent src degrades to the same placeholder the app already used.
 */
export default function Avatar({
  src,
  name = '',
  size = 40,
  ring = false,
  className = '',
  style,
  ...rest
}) {
  const [failed, setFailed] = useState(false);
  const resolved = src ? mediaUrl(src) : '';
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';

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
      src={resolved}
      alt={name || 'User'}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
      style={{ width: size, height: size, ...ringStyle, ...style }}
      {...rest}
    />
  );
}
