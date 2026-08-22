import { useEffect, useState } from 'react';
import { AlertTriangle, FlaskConical } from 'lucide-react';
import axios from '../services/api';
import { classifyEnvironment } from '../utils/environment';

/**
 * A permanent mark on anything that is not production.
 *
 * Not dismissible, and rendered outside the router so no page can avoid it.
 * Dismissible would defeat the purpose: the person most likely to close it is
 * the one who has been looking at staging all morning and has stopped noticing,
 * which is exactly who needs it when they open production in the next tab.
 *
 * The build-time value paints immediately, so a non-production page is marked
 * before anything renders. The API value arrives a moment later and can only
 * escalate -- a page that looks like production stays unmarked unless the API
 * disagrees, so production never flashes a banner it then has to retract.
 */
export default function EnvironmentBanner() {
  const buildEnv = import.meta.env.VITE_ENVIRONMENT;
  const [apiEnv, setApiEnv] = useState(null);

  useEffect(() => {
    let cancelled = false;

    /*
     * try/catch around the call itself, not only .catch() on the promise.
     *
     * A synchronous throw from the request layer never reaches .catch(), so it
     * escapes the effect and takes the whole app into the error boundary. This
     * is not hypothetical -- the route-mount harness raised exactly that on the
     * first run, because its fixture resolver throws before returning a promise.
     *
     * A component whose entire job is labelling the environment must not be
     * able to break the app it is labelling. Every failure here is swallowed
     * deliberately: an unreachable /api/version leaves apiEnv null, which keeps
     * the build-time verdict -- the safe half of the pair.
     */
    try {
      Promise.resolve(axios.get('/api/version'))
        .then((res) => { if (!cancelled) setApiEnv(res?.data?.environment ?? null); })
        .catch(() => {});
    } catch { /* never throw from here */ }

    return () => { cancelled = true; };
  }, []);

  const verdict = classifyEnvironment(buildEnv, apiEnv);
  if (verdict.kind === 'production') return null;

  const mismatch = verdict.kind === 'mismatch';

  return (
    <div
      role={mismatch ? 'alert' : 'status'}
      data-testid="environment-banner"
      data-env-kind={verdict.kind}
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: mismatch ? '12px 16px' : '7px 16px',
        // Deliberately not a theme token. This must look identical in light and
        // dark, and must not be restyleable into something ignorable.
        background: mismatch ? '#b91c1c' : '#a16207',
        color: '#fff',
        fontSize: mismatch ? 14 : 13,
        fontWeight: 600,
        letterSpacing: '0.01em',
        textAlign: 'center',
        lineHeight: 1.4
      }}
    >
      {mismatch ? <AlertTriangle size={17} strokeWidth={2.25} /> : <FlaskConical size={15} strokeWidth={2.25} />}
      <span>
        <strong style={{ textTransform: 'uppercase' }}>{verdict.title}</strong>
        {' — '}
        {verdict.body}
      </span>
    </div>
  );
}
