import { Link } from 'react-router-dom';

export default function Terms() {
  return (
    <div className="page-container" style={{ maxWidth: 720, margin: '0 auto', padding: '40px 24px' }}>
      <Link to="/" style={{ color: 'var(--fb-blue)', fontWeight: 600 }}>← Back</Link>
      <h1 style={{ fontSize: 28, fontWeight: 800, margin: '16px 0 8px' }}>Terms of Service</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 24 }}>Last updated: July 2026</p>

      <div className="glass-card" style={{ padding: 28, lineHeight: 1.7, fontSize: 15, color: 'var(--text-sub)' }}>
        <h2 style={{ fontSize: 18, color: 'var(--text-base)', marginBottom: 8 }}>1. Acceptance</h2>
        <p style={{ marginBottom: 16 }}>
          By creating an account or using Nexora, you agree to these Terms. If you do not agree, do not use the service.
        </p>

        <h2 style={{ fontSize: 18, color: 'var(--text-base)', marginBottom: 8 }}>2. Accounts</h2>
        <p style={{ marginBottom: 16 }}>
          You must provide accurate registration information. You are responsible for keeping your password secure
          and for activity under your account. We may suspend or remove accounts that violate these Terms.
        </p>

        <h2 style={{ fontSize: 18, color: 'var(--text-base)', marginBottom: 8 }}>3. Acceptable use</h2>
        <p style={{ marginBottom: 16 }}>
          Do not post illegal content, harassment, spam, malware, or content that infringes others&apos; rights.
          Do not attempt to break security, scrape excessively, or abuse points/rewards systems.
        </p>

        <h2 style={{ fontSize: 18, color: 'var(--text-base)', marginBottom: 8 }}>4. Content</h2>
        <p style={{ marginBottom: 16 }}>
          You retain ownership of content you post. You grant Nexora a license to host, display, and distribute
          that content within the service. You may delete your content or account subject to residual copies in backups.
        </p>

        <h2 style={{ fontSize: 18, color: 'var(--text-base)', marginBottom: 8 }}>5. Subscriptions &amp; points</h2>
        <p style={{ marginBottom: 16 }}>
          Paid plans and virtual points (if enabled) are subject to plan rules and applicable payment provider terms.
          Points have no cash value unless we explicitly state otherwise.
        </p>

        <h2 style={{ fontSize: 18, color: 'var(--text-base)', marginBottom: 8 }}>6. Disclaimer</h2>
        <p style={{ marginBottom: 16 }}>
          The service is provided &quot;as is&quot; without warranties. We are not liable for user-generated content
          or indirect damages to the extent allowed by law.
        </p>

        <h2 style={{ fontSize: 18, color: 'var(--text-base)', marginBottom: 8 }}>7. Contact</h2>
        <p>
          Questions about these Terms: use in-app support or the email configured by the site operator.
        </p>
      </div>
    </div>
  );
}
