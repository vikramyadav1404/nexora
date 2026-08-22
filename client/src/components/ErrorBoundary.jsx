import { Component } from 'react';
import { AlertTriangle, RotateCw, ArrowLeft } from 'lucide-react';

/**
 * App-level error boundary.
 *
 * Without this, any render-time throw produced a blank white page.
 *
 * ------------------------------------------------------------------
 * Transient vs permanent, and why it is worth the machinery
 * ------------------------------------------------------------------
 * This used to make one distinction -- chunk-load failure or not -- and told
 * everyone else "Reloading usually clears it." For a stale build that is true.
 * For a deterministic render throw it is false, and the page had been throwing
 * `ReferenceError: loading is not defined` on every render for every visitor
 * while the copy promised a reload would fix it.
 *
 * That is the empty-vs-broken collapse in a different costume: a permanent
 * failure presented as a transient one. So the boundary now finds out rather
 * than guessing. It records the error's signature before reloading; if the same
 * signature comes back, the reload demonstrably did not work and it says so
 * instead of offering the same button again.
 */

const ATTEMPT_KEY = 'nx_boundary_reload';

function isChunkLoadError(error) {
  const msg = String(error?.message || '');
  return (
    error?.name === 'ChunkLoadError' ||
    /Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed|dynamically imported module/i.test(
      msg
    )
  );
}

/**
 * A stable-enough identity for "the same failure again".
 *
 * Name plus message plus the first stack frame. Not the whole stack: minified
 * frame offsets shift between builds, and a signature that changes when the
 * bundle changes would report every recurrence as a new problem.
 */
export function errorSignature(error) {
  const name = String(error?.name || 'Error');
  const message = String(error?.message || '').slice(0, 200);
  const frame = String(error?.stack || '').split('\n')[1]?.trim().slice(0, 120) || '';
  return `${name}|${message}|${frame}`;
}

/** sessionStorage throws in some privacy modes; a boundary must never add a second error. */
function readAttempt() {
  try {
    return sessionStorage.getItem(ATTEMPT_KEY);
  } catch {
    return null;
  }
}

function writeAttempt(signature) {
  try {
    sessionStorage.setItem(ATTEMPT_KEY, signature);
  } catch { /* not worth failing over */ }
}

function clearAttempt() {
  try {
    sessionStorage.removeItem(ATTEMPT_KEY);
  } catch { /* ignore */ }
}

/**
 * Decide what to tell the user.
 *
 * Exported for tests: this is the judgement the component exists to make, and
 * it is worth asserting directly rather than through a rendered tree.
 */
export function classify(error, previousAttempt) {
  if (isChunkLoadError(error)) {
    return {
      kind: 'stale',
      title: 'A new version is available',
      body: 'This tab is running an older build of Nexora. Reload to pick up the latest one.',
      reloadHelps: true
    };
  }

  if (previousAttempt && previousAttempt === errorSignature(error)) {
    return {
      kind: 'permanent',
      title: 'This page is broken',
      body: 'Reloading did not fix it, so it is a bug on our side rather than something wrong with your session. It has been reported.',
      reloadHelps: false
    };
  }

  return {
    kind: 'unknown',
    title: 'Something broke',
    body: 'That page hit an unexpected error. A reload sometimes clears it — if it comes straight back, it is our bug and we have logged it.',
    reloadHelps: true
  };
}

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    // Read once at construction: handleReload writes to it before reloading, so
    // reading later would see this instance's own stamp rather than the prior one.
    this.state = { error: null, reference: null, previousAttempt: readAttempt() };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Unhandled UI error:', error, info?.componentStack);
    this.report(error, info);
  }

  /**
   * Ship it somewhere the operator can read.
   *
   * Fire-and-forget, every path swallowed: reporting a crash must never be able
   * to cause one. `keepalive` so the request survives the reload the user is
   * about to trigger.
   */
  report(error, info) {
    try {
      const payload = {
        message: String(error?.message || error || 'Unknown error'),
        stack: String(error?.stack || ''),
        componentStack: String(info?.componentStack || ''),
        route: typeof location !== 'undefined' ? location.pathname : '',
        commit: (typeof window !== 'undefined' && window.__NX_COMMIT__) || ''
      };

      fetch('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      })
        .then(r => (r.ok ? r.json() : null))
        .then(j => { if (j?.reference) this.setState({ reference: j.reference }); })
        .catch(() => {});
    } catch { /* never throw from here */ }
  }

  handleReload = () => {
    // Record what we are reloading for, so the next mount can tell whether it
    // worked. Without this the boundary can only ever guess.
    writeAttempt(errorSignature(this.state.error));

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

  handleBack = () => {
    // Leaving the broken route is the only thing that reliably helps, so clear
    // the stamp: the next failure elsewhere is a different problem.
    clearAttempt();
    window.location.assign('/');
  };

  render() {
    const { error, reference, previousAttempt } = this.state;
    if (!error) return this.props.children;

    const verdict = classify(error, previousAttempt);

    return (
      <div
        className="page-container"
        style={{ display: 'grid', placeItems: 'center', padding: 'var(--space-8) var(--space-4)' }}
      >
        <div className="error-state" style={{ maxWidth: 460 }}>
          <div className="error-state-icon">
            <AlertTriangle size={28} strokeWidth={1.75} />
          </div>
          <h3>{verdict.title}</h3>
          <p>{verdict.body}</p>

          <div className="error-state-action" style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            {/*
              * When a reload has already been shown not to work, it stops being
              * the primary action. Offering it again is the boundary insisting
              * on advice it has watched fail.
              */}
            {verdict.reloadHelps ? (
              <button type="button" className="btn btn-primary" onClick={this.handleReload}>
                <RotateCw size={16} />
                Reload Nexora
              </button>
            ) : (
              <>
                <button type="button" className="btn btn-primary" onClick={this.handleBack}>
                  <ArrowLeft size={16} />
                  Go to home
                </button>
                <button type="button" className="btn btn-ghost" onClick={this.handleReload}>
                  <RotateCw size={16} />
                  Try reloading anyway
                </button>
              </>
            )}
          </div>

          {/*
            * The reference is the whole point of reporting: it lets a user's
            * "it broke" become a specific line in the logs.
            */}
          {reference && (
            <p style={{ marginTop: 'var(--space-4)', fontSize: 12, color: 'var(--text-faint)' }}>
              Reference <code>{reference}</code>
            </p>
          )}

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
