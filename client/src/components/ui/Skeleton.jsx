/**
 * Skeleton primitives.
 *
 * These replace the inline-styled skeleton markup that was copy-pasted into
 * Feed, Questions and Leaderboard. Shapes should mirror the real content so
 * the swap does not shift layout.
 */

export function Skeleton({ width, height, radius, className = '', style, ...rest }) {
  return (
    <div
      className={`skeleton ${className}`.trim()}
      aria-hidden="true"
      style={{ width, height, borderRadius: radius, ...style }}
      {...rest}
    />
  );
}

export function SkeletonText({ width = '100%', lines = 1, ...rest }) {
  if (lines === 1) return <Skeleton className="skeleton-text" width={width} {...rest} />;
  return (
    <>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className="skeleton-text"
          // Last line runs short, the way real wrapped text does
          width={i === lines - 1 ? '65%' : width}
          {...rest}
        />
      ))}
    </>
  );
}

export function SkeletonAvatar({ size = 40 }) {
  return <Skeleton className="skeleton-avatar" width={size} height={size} />;
}

/** A post-shaped placeholder: avatar + name/meta, two text lines, media block. */
export function SkeletonPostCard({ withMedia = true }) {
  return (
    <div className="skeleton-card" aria-hidden="true">
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 14 }}>
        <SkeletonAvatar size={40} />
        <div style={{ flex: 1 }}>
          <Skeleton className="skeleton-title" width="38%" style={{ marginBottom: 8 }} />
          <Skeleton className="skeleton-text" width="22%" />
        </div>
      </div>
      <SkeletonText lines={2} />
      {withMedia && (
        <Skeleton className="skeleton-block" height={260} style={{ marginTop: 14 }} />
      )}
    </div>
  );
}

export function SkeletonQuestionCard() {
  return (
    <div className="skeleton-card" aria-hidden="true">
      <Skeleton className="skeleton-title" width="72%" style={{ marginBottom: 12 }} />
      <SkeletonText lines={2} />
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <Skeleton width={64} height={22} radius="var(--r-xs)" />
        <Skeleton width={48} height={22} radius="var(--r-xs)" />
      </div>
    </div>
  );
}

export function SkeletonListRow({ size = 40 }) {
  return (
    <div
      aria-hidden="true"
      style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 12px' }}
    >
      <SkeletonAvatar size={size} />
      <div style={{ flex: 1 }}>
        <Skeleton className="skeleton-title" width="42%" style={{ marginBottom: 8 }} />
        <Skeleton className="skeleton-text" width="26%" />
      </div>
    </div>
  );
}

/** Renders `count` copies of any skeleton component. */
export function SkeletonList({ count = 3, Item = SkeletonPostCard, ...itemProps }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: count }, (_, i) => (
        <Item key={i} {...itemProps} />
      ))}
    </div>
  );
}

export default Skeleton;
