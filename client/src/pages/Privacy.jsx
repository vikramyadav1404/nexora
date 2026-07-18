import { Link } from 'react-router-dom';

export default function Privacy() {
  return (
    <div className="page-container" style={{ maxWidth: 720, margin: '0 auto', padding: '40px 24px' }}>
      <Link to="/" style={{ color: 'var(--fb-blue)', fontWeight: 600 }}>← Back</Link>
      <h1 style={{ fontSize: 28, fontWeight: 800, margin: '16px 0 8px' }}>Privacy Policy</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 24 }}>Last updated: July 2026</p>

      <div className="glass-card" style={{ padding: 28, lineHeight: 1.7, fontSize: 15, color: 'var(--text-sub)' }}>
        <h2 style={{ fontSize: 18, color: 'var(--text-base)', marginBottom: 8 }}>1. Data we collect</h2>
        <p style={{ marginBottom: 16 }}>
          Account data (name, email, password hash, optional phone), profile info, posts, questions, answers,
          likes, follows, and technical logs needed to run the service.
        </p>

        <h2 style={{ fontSize: 18, color: 'var(--text-base)', marginBottom: 8 }}>2. How we use data</h2>
        <p style={{ marginBottom: 16 }}>
          To provide social and Q&amp;A features, personalize your feed, send security emails (password reset,
          verification), process payments if enabled, and improve reliability and safety.
        </p>

        <h2 style={{ fontSize: 18, color: 'var(--text-base)', marginBottom: 8 }}>3. Storage &amp; security</h2>
        <p style={{ marginBottom: 16 }}>
          Data is stored in our database (Supabase Postgres) and optional object storage. Passwords are hashed.
          Access to server secrets is restricted. No method of transmission is 100% secure.
        </p>

        <h2 style={{ fontSize: 18, color: 'var(--text-base)', marginBottom: 8 }}>4. Sharing</h2>
        <p style={{ marginBottom: 16 }}>
          We do not sell your personal data. We may use infrastructure providers (hosting, email, payments)
          who process data on our behalf under contractual safeguards.
        </p>

        <h2 style={{ fontSize: 18, color: 'var(--text-base)', marginBottom: 8 }}>5. Your rights</h2>
        <p style={{ marginBottom: 16 }}>
          You can update profile information in Settings, request verification of your email, and delete your
          account permanently from Settings → Account (this removes your primary data from the live database).
        </p>

        <h2 style={{ fontSize: 18, color: 'var(--text-base)', marginBottom: 8 }}>6. Cookies &amp; local storage</h2>
        <p style={{ marginBottom: 16 }}>
          We use browser local storage for auth tokens and theme preferences so you stay signed in on this device.
        </p>

        <h2 style={{ fontSize: 18, color: 'var(--text-base)', marginBottom: 8 }}>7. Contact</h2>
        <p>
          Privacy requests: contact the site operator. See also our <Link to="/terms" style={{ color: 'var(--fb-blue)' }}>Terms of Service</Link>.
        </p>
      </div>
    </div>
  );
}
