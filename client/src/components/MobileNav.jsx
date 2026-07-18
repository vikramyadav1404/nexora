import { NavLink, useLocation } from 'react-router-dom';
import { Home, Layers, HelpCircle, Bell, User } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

/**
 * Bottom tab bar for phones — quick navigation like a native app.
 */
export default function MobileNav() {
  const { user } = useAuth();
  const location = useLocation();
  const userId = user?._id || user?.id;

  if (!user) return null;

  const tabs = [
    { to: '/feed', icon: Home, label: 'Home', match: (p) => p === '/feed' },
    { to: '/spaces', icon: Layers, label: 'Spaces', match: (p) => p.startsWith('/spaces') },
    { to: '/qa', icon: HelpCircle, label: 'Q&A', match: (p) => p.startsWith('/qa') || p === '/ask' },
    { to: '/notifications', icon: Bell, label: 'Alerts', match: (p) => p.startsWith('/notifications') },
    {
      to: userId ? `/profile/${userId}` : '/settings',
      icon: User,
      label: 'Me',
      match: (p) => p.startsWith('/profile') || p === '/settings'
    }
  ];

  return (
    <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
      {tabs.map(({ to, icon: Icon, label, match }) => {
        const active = match(location.pathname);
        return (
          <NavLink
            key={to}
            to={to}
            className={`mobile-nav-item ${active ? 'active' : ''}`}
          >
            <Icon size={22} strokeWidth={active ? 2.4 : 2} />
            <span>{label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
