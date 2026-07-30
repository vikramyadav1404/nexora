import { AlertTriangle, RotateCw } from 'lucide-react';

/**
 * Shared failure state.
 *
 * Before this existed every failed fetch fell through to the empty state, so
 * "we could not load this" and "there is nothing here" looked identical and
 * neither offered a retry. Always pass `onRetry` when the fetch is repeatable.
 */
export default function ErrorState({
  title = 'Could not load this',
  description = 'Something went wrong on our end. Check your connection and try again.',
  onRetry,
  retryLabel = 'Try again',
  className = ''
}) {
  return (
    <div className={`error-state ${className}`.trim()} role="alert">
      <div className="error-state-icon">
        <AlertTriangle size={28} strokeWidth={1.75} />
      </div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {onRetry && (
        <div className="error-state-action">
          <button type="button" className="btn btn-secondary" onClick={onRetry}>
            <RotateCw size={16} />
            {retryLabel}
          </button>
        </div>
      )}
    </div>
  );
}
