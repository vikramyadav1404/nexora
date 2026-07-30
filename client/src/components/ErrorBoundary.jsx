import { Component } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';

/**
 * App-level error boundary.
 *
 * Without this, any render-time throw produced a blank white page. The case
 * that actually bites in production is a lazy-chunk 404: after a deploy the
 * cached index.html points at asset hashes that no longer exist, React.lazy
 * rejects, and the user is stuck with nothing. We detect that specifically
 * and offer a reload, which fetches the current build.
 */
function isChunkLoadError(error) {
  const msg = String(error?.message || '');
  return (
    error?.name === 'ChunkLoadError' ||
    /Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed|dynamically imported module/i.test(
      msg
    )
  );
}

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the stack in the console; there is no error-reporting service wired up.
    console.error('Unhandled UI error:', error, info?.componentStack);
  }

  handleReload = () => {
    // A stale service-worker shell is the usual cause — clear it before reloading.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => Promise.all(regs.map((r) => r.unregister())))
        .catch(() => {})
        .finally(() => window.location.reload());
      return;
    }
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const stale = isChunkLoadError(error);

    return (
      <div
        className="page-container"
        style={{ display: 'grid', placeItems: 'center', padding: 'var(--space-8) var(--space-4)' }}
      >
        <div className="error-state" style={{ maxWidth: 460 }}>
          <div className="error-state-icon">
            <AlertTriangle size={28} strokeWidth={1.75} />
          </div>
          <h3>{stale ? 'A new version is available' : 'Something broke'}</h3>
          <p>
            {stale
              ? 'This tab is running an older build of Nexora. Reload to pick up the latest one.'
              : 'That page hit an unexpected error. Reloading usually clears it.'}
          </p>
          <div className="error-state-action">
            <button type="button" className="btn btn-primary" onClick={this.handleReload}>
              <RotateCw size={16} />
              Reload Nexora
            </button>
          </div>
          {import.meta.env.DEV && (
            <pre
              style={{
                marginTop: 'var(--space-5)',
                textAlign: 'left',
                fontSize: 12,
                color: 'var(--text-faint)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              }}
            >
              {String(error?.stack || error)}
            </pre>
          )}
        </div>
      </div>
    );
  }
}
