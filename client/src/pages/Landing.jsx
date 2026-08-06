import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import toast from 'react-hot-toast';
import { Layers, MessageSquare, Trophy } from 'lucide-react';
import AuthForm from '../components/AuthForm';
import mark from '../assets/hero.png';

const PITCH = [
  {
    icon: Layers,
    title: 'Spaces, not a firehose',
    body: '16 interest communities. Pick yours at signup and your feed arrives already worth reading.'
  },
  {
    icon: MessageSquare,
    title: 'Questions that get resolved',
    body: 'Ask, answer, upvote, accept. The accepted answer sits at the top where the next person will find it.'
  },
  {
    icon: Trophy,
    title: 'Points you can actually spend',
    body: 'Earn them by helping. Send them to someone who helped you. Badges and streaks come along the way.'
  }
];

export default function Landing() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!authLoading && user) {
      navigate(user.onboardingCompleted ? '/feed' : '/onboarding', { replace: true });
    }
  }, [user, authLoading, navigate]);

  const afterLogin = (u) => {
    toast.success('Logged in');
    navigate(u?.onboardingCompleted ? '/feed' : '/onboarding');
  };

  // The code step lives on /login rather than being built twice. Handing the
  // pending token over in router state keeps it out of the URL and out of
  // anything persistent.
  const goVerify = (mfaToken) => navigate('/login', { state: { mfaToken }, replace: true });

  if (authLoading || user) return null;

  return (
    <div className="auth-shell">
      <div className="auth-shell-main">
        <div className="auth-shell-copy">
          <img src={mark} alt="" className="auth-shell-mark" width="72" height="76" />
          <div className="auth-shell-logo">nexora</div>

          <h1 className="auth-shell-tagline">
            Build a network first.<br />
            <span className="auth-shell-accent">Then broadcast.</span>
          </h1>

          <p className="auth-shell-sub">
            Most feeds hand you a megaphone on day one. Nexora doesn&rsquo;t &mdash; your daily
            posting limit grows with the people you actually connect to. Show up, answer
            something, earn the room.
          </p>

          <ul className="auth-shell-points">
            {PITCH.map(({ icon: Icon, title, body }) => (
              <li key={title}>
                <span className="auth-shell-point-icon" aria-hidden="true">
                  <Icon size={18} />
                </span>
                <div>
                  <strong>{title}</strong>
                  <p>{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <div className="auth-shell-card animate-slideUp">
            <AuthForm idPrefix="landing" onSuccess={afterLogin} onMfaRequired={goVerify} />
          </div>

          <p className="auth-shell-note">
            Free to join. Paid tiers only raise how many questions you can ask per day.
          </p>
        </div>
      </div>

      <footer className="auth-shell-footer">
        <Link to="/terms">Terms</Link>
        <span aria-hidden="true"> · </span>
        <Link to="/privacy">Privacy</Link>
        <div style={{ marginTop: 12 }}>
          © {new Date().getFullYear()} Nexora
        </div>
      </footer>
    </div>
  );
}
