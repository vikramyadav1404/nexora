import { useState, useRef, useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Home, Rss, HelpCircle, CreditCard, Trophy, Settings, LogOut, User, Bell, Menu, X, Star } from 'lucide-react';
import { TRANSLATIONS } from '../i18n/translations';

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropRef = useRef(null);
  const t = TRANSLATIONS[user?.language || 'en'];

  useEffect(() => {
    const handler = (e) => {
      if (dropRef.current && !dropRef.current.contains(e.target)) setDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  const initials = user?.name?.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || 'U';

  return (
    <nav className="navbar">
      {/* Brand */}
      <NavLink to="/feed" className="navbar-brand">
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
          <polygon points="14,2 26,8 26,20 14,26 2,20 2,8" fill="url(#ng)" opacity="0.9"/>
          <polygon points="14,6 22,10 22,18 14,22 6,18 6,10" fill="none" stroke="white" strokeWidth="1.5" opacity="0.5"/>
          <circle cx="14" cy="14" r="3" fill="white"/>
          <defs>
            <linearGradient id="ng" x1="0" y1="0" x2="28" y2="28">
              <stop offset="0%" stopColor="#7c3aed"/>
              <stop offset="100%" stopColor="#06b6d4"/>
            </linearGradient>
          </defs>
        </svg>
        Nexora
      </NavLink>

      {/* Nav links */}
      <div className={`navbar-nav ${menuOpen ? 'open' : ''}`}>
        <NavLink to="/feed" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} onClick={() => setMenuOpen(false)}>
          <Rss size={16} /> {t.feed}
        </NavLink>
        <NavLink to="/qa" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} onClick={() => setMenuOpen(false)}>
          <HelpCircle size={16} /> {t.qa}
        </NavLink>
        <NavLink to="/subscriptions" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} onClick={() => setMenuOpen(false)}>
          <CreditCard size={16} /> {t.subscriptions}
        </NavLink>
        <NavLink to="/leaderboard" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} onClick={() => setMenuOpen(false)}>
          <Trophy size={16} /> {t.leaderboard}
        </NavLink>
      </div>

      {/* Right actions */}
      <div className="navbar-actions">
        {/* Points badge */}
        {user && (
          <div className="points-display" style={{ fontSize: '13px', padding: '6px 12px' }}>
            <Star size={14} />
            {user.points || 0}
          </div>
        )}

        {/* User dropdown */}
        <div className="dropdown" ref={dropRef}>
          <button onClick={() => setDropdownOpen(!dropdownOpen)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            {user?.avatar
              ? <img src={user.avatar} alt={user.name} className="avatar" />
              : <div className="avatar-placeholder">{initials}</div>
            }
          </button>
          {dropdownOpen && (
            <div className="dropdown-menu">
              <div style={{ padding: '8px 12px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)', marginBottom: '8px' }}>
                <div style={{ fontSize: '14px', fontWeight: 600 }}>{user?.name}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{user?.email}</div>
                <div style={{ marginTop: '6px' }}>
                  <span className={`badge badge-plan-${user?.subscription?.plan || 'free'}`}>
                    {(user?.subscription?.plan || 'free').toUpperCase()}
                  </span>
                </div>
              </div>
              <button className="dropdown-item" onClick={() => { navigate(`/profile/${user?._id || user?.id}`); setDropdownOpen(false); }}>
                <User size={15} /> {t.profile}
              </button>
              <button className="dropdown-item" onClick={() => { navigate('/settings'); setDropdownOpen(false); }}>
                <Settings size={15} /> {t.settings}
              </button>
              <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)', margin: '6px 0' }} />
              <button className="dropdown-item danger" onClick={handleLogout}>
                <LogOut size={15} /> {t.logout}
              </button>
            </div>
          )}
        </div>

        {/* Mobile menu toggle */}
        <button className="hamburger" onClick={() => setMenuOpen(!menuOpen)} aria-label="Toggle menu">
          {menuOpen ? <X size={20} color="var(--text-primary)" /> : <Menu size={20} color="var(--text-secondary)" />}
        </button>
      </div>
    </nav>
  );
}
