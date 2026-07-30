import { useState, useRef, useEffect } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { useAuth } from '../contexts/AuthContext';
import {
  Home, HelpCircle, CreditCard, Trophy, Settings, LogOut,
  Search, Bell, Layers, Bookmark, Target, Star
} from 'lucide-react';
import { TRANSLATIONS } from '../i18n/translations';
import { Avatar, IconButton } from './ui';
import useUnreadCount from '../hooks/useUnreadCount';
import useReducedMotion from '../hooks/useReducedMotion';

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [search, setSearch] = useState('');
  const dropRef = useRef(null);
  const unread = useUnreadCount();
  const reduced = useReducedMotion();
  const t = TRANSLATIONS[user?.language || 'en'];

  useEffect(() => {
    const handler = (e) => {
      if (dropRef.current && !dropRef.current.contains(e.target)) setDropdownOpen(false);
    };
    const onEsc = (e) => {
      if (e.key === 'Escape') setDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', onEsc);
    };
  }, []);

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  const isActive = (path) => location.pathname === path || location.pathname.startsWith(`${path}/`);

  return (
    <nav className="navbar" aria-label="Primary">
      <NavLink to="/feed" className="navbar-brand" title="Nexora" aria-label="Nexora home">
        <span className="brand-text" aria-hidden="true">n</span>
      </NavLink>

      <div className="navbar-search">
        <Search size={16} />
        <input
          type="search"
          placeholder="Search Nexora"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && search.trim()) {
              navigate(`/search?q=${encodeURIComponent(search.trim())}`);
              setSearch('');
            }
          }}
        />
      </div>

      {/*
        No hamburger here any more. Below 768px this row hides entirely and
        MobileNav's tab bar is the only navigation — previously both were live
        at once and exposed overlapping destinations.
      */}
      <div className="navbar-nav">
        <NavLink to="/feed" className={({ isActive: a }) => `nav-link ${a ? 'active' : ''}`} title={t.feed}>
          <Home size={24} strokeWidth={isActive('/feed') ? 2.5 : 2} />
          <span className="nav-link-label">{t.feed}</span>
        </NavLink>
        <NavLink to="/spaces" className={({ isActive: a }) => `nav-link ${a ? 'active' : ''}`} title="Spaces">
          <Layers size={24} strokeWidth={isActive('/spaces') ? 2.5 : 2} />
          <span className="nav-link-label">Spaces</span>
        </NavLink>
        <NavLink to="/qa" className={({ isActive: a }) => `nav-link ${a ? 'active' : ''}`} title={t.qa}>
          <HelpCircle size={24} strokeWidth={isActive('/qa') ? 2.5 : 2} />
          <span className="nav-link-label">{t.qa}</span>
        </NavLink>
        <NavLink to="/challenges" className={({ isActive: a }) => `nav-link ${a ? 'active' : ''}`} title="Challenges">
          <Target size={24} strokeWidth={isActive('/challenges') ? 2.5 : 2} />
          <span className="nav-link-label">Challenges</span>
        </NavLink>
        <NavLink to="/leaderboard" className={({ isActive: a }) => `nav-link ${a ? 'active' : ''}`} title={t.leaderboard}>
          <Trophy size={24} strokeWidth={isActive('/leaderboard') ? 2.5 : 2} />
          <span className="nav-link-label">{t.leaderboard}</span>
        </NavLink>
      </div>

      <div className="navbar-actions">
        <IconButton icon={Search} label="Search" variant="filled" onClick={() => navigate('/search')} />
        <IconButton icon={Bookmark} label="Saved" variant="filled" onClick={() => navigate('/bookmarks')} />

        <div style={{ position: 'relative' }}>
          <IconButton
            icon={Bell}
            label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
            variant="filled"
            onClick={() => navigate('/notifications')}
          />
          {unread > 0 && (
            <span
              aria-hidden="true"
              style={{
                position: 'absolute', top: 0, right: 0, minWidth: 17, height: 17,
                borderRadius: 'var(--r-pill)', background: 'var(--red)',
                color: 'var(--text-on-accent)', fontSize: 10, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '0 5px', boxShadow: '0 0 0 2px var(--bg-surface)',
                pointerEvents: 'none'
              }}
            >
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </div>

        <IconButton icon={CreditCard} label="Plans" variant="filled" onClick={() => navigate('/subscriptions')} />

        {user && (
          <div className="points-display" style={{ fontSize: 13, height: 36 }} title="Your points">
            <Star size={14} fill="var(--gold)" color="var(--gold)" />
            {user.points || 0}
          </div>
        )}

        <div className="dropdown" ref={dropRef}>
          <button
            type="button"
            onClick={() => setDropdownOpen((v) => !v)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: 0, display: 'flex', borderRadius: '50%'
            }}
            aria-label="Account menu"
            aria-expanded={dropdownOpen}
            aria-haspopup="menu"
          >
            <Avatar src={user?.avatar} name={user?.name} size={40} />
          </button>

          <AnimatePresence>
            {dropdownOpen && (
              <motion.div
                className="dropdown-menu"
                role="menu"
                initial={reduced ? false : { opacity: 0, y: -6, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.97 }}
                transition={{ duration: reduced ? 0 : 0.16, ease: [0.16, 1, 0.3, 1] }}
                style={{ transformOrigin: 'top right' }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="dropdown-item"
                  style={{ marginBottom: 4, padding: 8 }}
                  onClick={() => {
                    navigate(`/profile/${user?._id || user?.id}`);
                    setDropdownOpen(false);
                  }}
                >
                  <Avatar src={user?.avatar} name={user?.name} size={36} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>{user?.name}</div>
                    <div style={{ fontSize: 13, color: 'var(--text-faint)' }}>See your profile</div>
                  </div>
                </button>

                <div style={{ height: 1, background: 'var(--border-soft)', margin: '4px 0 8px' }} />

                <button
                  type="button"
                  role="menuitem"
                  className="dropdown-item"
                  onClick={() => { navigate('/settings'); setDropdownOpen(false); }}
                >
                  <Settings size={18} /> {t.settings}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="dropdown-item"
                  onClick={() => { navigate('/bookmarks'); setDropdownOpen(false); }}
                >
                  <Bookmark size={18} /> Saved
                </button>

                <div style={{ height: 1, background: 'var(--border-soft)', margin: '4px 0' }} />

                <button type="button" role="menuitem" className="dropdown-item danger" onClick={handleLogout}>
                  <LogOut size={18} /> {t.logout}
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </nav>
  );
}
