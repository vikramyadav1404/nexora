import { NavLink, useLocation } from 'react-router-dom';
import { Home, Layers, HelpCircle, Bell, User } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import useUnreadCount from '../hooks/useUnreadCount';

function haptic(ms = 6) {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    try { navigator.vibrate(ms); } catch { /* unsupported */ }
  }
}

/**
 * Bottom tab bar for phones.
 *
 * Adds what a native tab bar has and this one lacked: an unread badge, a press
 * state, and re-tapping the active tab scrolling back to top.
 */
export default function MobileNav() {
  const { user } = useAuth();
  const location = useLocation();
  const unread = useUnreadCount();
  const userId = user?._id || user?.id;

  if (!user) return null;

  const tabs = [
    { to: '/feed', icon: Home, label: 'Home', match: (p) => p === '/feed' },
    { to: '/spaces', icon: Layers, label: 'Spaces', match: (p) => p.startsWith('/spaces') },
    { to: '/qa', icon: HelpCircle, label: 'Q&A', match: (p) => p.startsWith('/qa') || p === '/ask' },
    {
      to: '/notifications',
      icon: Bell,
      label: 'Alerts',
      match: (p) => p.startsWith('/notifications'),
      badge: unread
    },
    {
      to: userId ? `/profile/${userId}` : '/settings',
      icon: User,
      label: 'Me',
      match: (p) => p.startsWith('/profile') || p === '/settings'
    }
  ];

  return (
    <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
      {tabs.map(({ to, icon: Icon, label, match, badge }) => {
        const active = match(location.pathname);
        return (
          <NavLink
            key={to}
            to={to}
            className={`mobile-nav-item ${active ? 'active' : ''}`}
            aria-current={active ? 'page' : undefined}
            onClick={(e) => {
              haptic();
              // Re-tapping the current tab returns you to the top, like iOS
              if (active) {
                e.preventDefault();
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }
            }}
          >
            <span className="mobile-nav-icon">
              <Icon size={22} strokeWidth={active ? 2.4 : 2} />
              {badge > 0 && (
                <span className="mobile-nav-badge" aria-label={`${badge} unread`}>
                  {badge > 9 ? '9+' : badge}
                </span>
              )}
            </span>
            <span>{label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
