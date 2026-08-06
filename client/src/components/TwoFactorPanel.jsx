import { useState, useEffect, useCallback } from 'react';
import axios from '../services/api';
import toast from 'react-hot-toast';
import { ShieldCheck, ShieldOff, Copy, Download, KeyRound } from 'lucide-react';

/**
 * Two-factor setup, living in Settings → Account.
 *
 * Three states rather than a wizard: off, mid-enrolment, and on. Enrolment is
 * deliberately two server calls — /mfa/setup mints the secret, /mfa/enable turns
 * it on only after a code proves the app actually scanned it. Anyone who closes
 * this panel halfway still has a working account, because nothing was switched
 * on yet.
 */
export default function TwoFactorPanel() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  // Enrolment
  const [setupData, setSetupData] = useState(null);
  const [enrolCode, setEnrolCode] = useState('');

  // Shown exactly once, straight after enabling or regenerating.
  const [backupCodes, setBackupCodes] = useState(null);

  // Turning it off / reissuing codes
  const [password, setPassword] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [mode, setMode] = useState(null); // 'disable' | 'regenerate'

  const load = useCallback(async () => {
    try {
      const res = await axios.get('/api/auth/mfa/status');
      setStatus(res.data);
    } catch {
      // Most likely migration 010 has not been run. Leave the panel out of the
      // way rather than showing a broken control.
      setStatus({ enabled: false, unavailable: true });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const reset = () => {
    setSetupData(null);
    setEnrolCode('');
    setPassword('');
    setDisableCode('');
    setMode(null);
  };

  const startSetup = async () => {
    setBusy(true);
    try {
      const res = await axios.post('/api/auth/mfa/setup');
      setSetupData(res.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not start setup');
    } finally {
      setBusy(false);
    }
  };

  const confirmSetup = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await axios.post('/api/auth/mfa/enable', { code: enrolCode });
      setBackupCodes(res.data.backupCodes);
      setSetupData(null);
      setEnrolCode('');
      toast.success('Two-factor authentication is on');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'That code is not valid');
    } finally {
      setBusy(false);
    }
  };

  const submitDisable = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await axios.post('/api/auth/mfa/disable', { password, code: disableCode });
      toast.success('Two-factor authentication is off');
      reset();
      setBackupCodes(null);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not turn off two-factor');
    } finally {
      setBusy(false);
    }
  };

  const submitRegenerate = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await axios.post('/api/auth/mfa/backup-codes', { password });
      setBackupCodes(res.data.backupCodes);
      reset();
      toast.success('New backup codes generated');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not generate codes');
    } finally {
      setBusy(false);
    }
  };

  const copyCodes = () => {
    navigator.clipboard.writeText(backupCodes.join('\n'))
      .then(() => toast.success('Copied'))
      .catch(() => toast.error('Could not copy'));
  };

  const downloadCodes = () => {
    const body =
      'Nexora backup codes\n' +
      `Generated ${new Date().toLocaleString()}\n\n` +
      backupCodes.join('\n') +
      '\n\nEach code works once. Keep them somewhere you can reach without your phone.\n';
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nexora-backup-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!status) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 14 }}>
        <div className="spinner" /> Loading two-factor status…
      </div>
    );
  }

  if (status.unavailable) return null;

  const sectionStyle = { borderTop: '1px solid var(--border-soft)', paddingTop: 20, marginBottom: 24 };
  const boxStyle = { padding: 16, background: 'var(--bg-raised)', borderRadius: 'var(--r-md)', marginTop: 12 };

  return (
    <div style={sectionStyle}>
      <h3 style={{ fontSize: 16, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        {status.enabled
          ? <ShieldCheck size={17} style={{ color: 'var(--success)' }} />
          : <ShieldOff size={17} style={{ color: 'var(--text-faint)' }} />}
        Two-factor authentication
        {status.enabled && (
          <span className="badge badge-contributor" style={{ marginLeft: 4 }}>On</span>
        )}
      </h3>

      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 4, lineHeight: 1.55 }}>
        {status.enabled
          ? 'Signing in needs a code from your authenticator app as well as your password.'
          : 'Add a second step to sign-in: a 6-digit code from an app like Google Authenticator, ' +
            'Authy or your password manager. A stolen password stops being enough on its own.'}
      </p>

      {/* ---------- backup codes, shown once ---------- */}
      {backupCodes && (
        <div style={{ ...boxStyle, border: '1px solid var(--nx-violet)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <KeyRound size={16} style={{ color: 'var(--nx-violet)' }} />
            <strong style={{ fontSize: 14 }}>Save your backup codes</strong>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
            These are the only way back in if you lose your phone. Each one works once.
            <strong> They will not be shown again.</strong>
          </p>

          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 14,
            marginBottom: 12
          }}>
            {backupCodes.map(c => (
              <div key={c} style={{
                padding: '6px 8px', background: 'var(--bg-base)', borderRadius: 'var(--r-sm)',
                textAlign: 'center', letterSpacing: '0.04em'
              }}>{c}</div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={copyCodes}>
              <Copy size={14} /> Copy
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={downloadCodes}>
              <Download size={14} /> Download
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setBackupCodes(null)}>
              I've saved them
            </button>
          </div>
        </div>
      )}

      {/* ---------- off: start enrolment ---------- */}
      {!status.enabled && !setupData && !backupCodes && (
        <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 12 }}
          disabled={busy} onClick={startSetup}>
          {busy ? <div className="spinner" /> : <ShieldCheck size={14} />} Set up two-factor
        </button>
      )}

      {/* ---------- mid-enrolment ---------- */}
      {setupData && (
        <div style={boxStyle}>
          <p style={{ fontSize: 13, marginBottom: 12, lineHeight: 1.5 }}>
            <strong>1.</strong> Scan this with your authenticator app.
          </p>

          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <img
              src={setupData.qr}
              alt="Two-factor setup QR code"
              width={180}
              height={180}
              style={{ background: '#fff', padding: 8, borderRadius: 'var(--r-md)' }}
            />

            <div style={{ flex: 1, minWidth: 200 }}>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 6 }}>
                Can't scan? Enter this key by hand:
              </p>
              <code style={{
                display: 'block', padding: '8px 10px', background: 'var(--bg-base)',
                borderRadius: 'var(--r-sm)', fontSize: 13, wordBreak: 'break-all',
                letterSpacing: '0.06em', marginBottom: 8
              }}>
                {setupData.secret}
              </code>
              <button type="button" className="btn btn-secondary btn-sm"
                onClick={() => navigator.clipboard.writeText(setupData.secret)
                  .then(() => toast.success('Key copied'))
                  .catch(() => toast.error('Could not copy'))}>
                <Copy size={13} /> Copy key
              </button>
            </div>
          </div>

          <form onSubmit={confirmSetup} style={{ marginTop: 18 }}>
            <p style={{ fontSize: 13, marginBottom: 8, lineHeight: 1.5 }}>
              <strong>2.</strong> Enter the 6-digit code it shows.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                className="form-input"
                placeholder="123456"
                value={enrolCode}
                onChange={e => setEnrolCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                maxLength={6}
                inputMode="numeric"
                autoComplete="one-time-code"
                style={{ width: 130, letterSpacing: 4, textAlign: 'center' }}
              />
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy || enrolCode.length !== 6}>
                {busy ? <div className="spinner" /> : 'Turn on'}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={reset} disabled={busy}>
                Cancel
              </button>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 10 }}>
              Turning this on signs you out everywhere else.
            </p>
          </form>
        </div>
      )}

      {/* ---------- on: manage ---------- */}
      {status.enabled && !backupCodes && (
        <>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8, marginBottom: 12 }}>
            {status.backupCodesRemaining} backup code{status.backupCodesRemaining === 1 ? '' : 's'} remaining
            {status.backupCodesRemaining <= 2 && (
              <strong style={{ color: 'var(--danger)' }}> — generate more</strong>
            )}
          </p>

          {!mode && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMode('regenerate')}>
                <KeyRound size={14} /> New backup codes
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMode('disable')}>
                <ShieldOff size={14} /> Turn off
              </button>
            </div>
          )}

          {mode === 'regenerate' && (
            <form onSubmit={submitRegenerate} style={boxStyle}>
              <p style={{ fontSize: 13, marginBottom: 10 }}>
                Confirm your password. Your existing codes will stop working.
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input type="password" className="form-input" placeholder="Password" autoComplete="current-password"
                  value={password} onChange={e => setPassword(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
                <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !password}>
                  {busy ? <div className="spinner" /> : 'Generate'}
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={reset} disabled={busy}>
                  Cancel
                </button>
              </div>
            </form>
          )}

          {mode === 'disable' && (
            <form onSubmit={submitDisable} style={boxStyle}>
              <p style={{ fontSize: 13, marginBottom: 10 }}>
                Confirm your password <em>and</em> a current code. A backup code works too.
              </p>
              <div style={{ display: 'grid', gap: 8 }}>
                <input type="password" className="form-input" placeholder="Password" autoComplete="current-password"
                  value={password} onChange={e => setPassword(e.target.value)} />
                <input className="form-input" placeholder="123456 or a backup code" autoComplete="one-time-code"
                  value={disableCode} onChange={e => setDisableCode(e.target.value)} maxLength={11} />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="submit" className="btn btn-danger btn-sm"
                    disabled={busy || !password || disableCode.trim().length < 6}>
                    {busy ? <div className="spinner" /> : 'Turn off two-factor'}
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={reset} disabled={busy}>
                    Cancel
                  </button>
                </div>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}
