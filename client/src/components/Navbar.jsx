import { useState, useRef, useEffect } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import axios from '../api';
import {
  Home, HelpCircle, CreditCard, Trophy, Settings, LogOut,
  User, Menu, X, Search, Bell, Layers, Bookmark, Target, Star
} from 'lucide-react';
import { TRANSLATIONS } from '../i18n/translations';

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [unread, setUnread] = useState(0);
  const dropRef = useRef(null);
  const t = TRANSLATIONS[user?.language || 'en'];

  useEffect(() => {
    const handler = (e) => {
      if (dropRef.current && !dropRef.current.contains(e.target)) setDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    axios.get('/api/notifications')
      .then(res => setUnread(res.data.unread || 0))
      .catch(() => {});
  }, [location.pathname]);

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  const initials = user?.name?.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || 'U';
  const isActive = (path) => location.pathname === path || location.pathname.startsWith(path + '/');

  return (
    <nav className="navbar">
      <NavLink to="/feed" className="navbar-brand" title="Nexora">
        <span className="brand-text">n</span>
      </NavLink>

      <div className="navbar-search">
        <Search size={16} />
        <input
          type="search"
          placeholder="Search Nexora"
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && search.trim()) {
              navigate(`/search?q=${encodeURIComponent(search.trim())}`);
              setSearch('');
            }
          }}
          onFocus={() => {}}
        />
      </div>

      <div className={`navbar-nav ${menuOpen ? 'open' : ''}`}>
        <NavLink to="/feed" className={({ isActive: a }) => `nav-link ${a ? 'active' : ''}`} onClick={() => setMenuOpen(false)} title={t.feed}>
          <Home size={24} strokeWidth={isActive('/feed') ? 2.5 : 2} />
          <span className="nav-link-label">{t.feed}</span>
        </NavLink>
        <NavLink to="/spaces" className={({ isActive: a }) => `nav-link ${a ? 'active' : ''}`} onClick={() => setMenuOpen(false)} title="Spaces">
          <Layers size={24} strokeWidth={isActive('/spaces') ? 2.5 : 2} />
          <span className="nav-link-label">Spaces</span>
        </NavLink>
        <NavLink to="/qa" className={({ isActive: a }) => `nav-link ${a ? 'active' : ''}`} onClick={() => setMenuOpen(false)} title={t.qa}>
          <HelpCircle size={24} strokeWidth={isActive('/qa') ? 2.5 : 2} />
          <span className="nav-link-label">{t.qa}</span>
        </NavLink>
        <NavLink to="/challenges" className={({ isActive: a }) => `nav-link ${a ? 'active' : ''}`} onClick={() => setMenuOpen(false)} title="Challenges">
          <Target size={24} strokeWidth={isActive('/challenges') ? 2.5 : 2} />
          <span className="nav-link-label">Challenges</span>
        </NavLink>
        <NavLink to="/leaderboard" className={({ isActive: a }) => `nav-link ${a ? 'active' : ''}`} onClick={() => setMenuOpen(false)} title={t.leaderboard}>
          <Trophy size={24} strokeWidth={isActive('/leaderboard') ? 2.5 : 2} />
          <span className="nav-link-label">{t.leaderboard}</span>
        </NavLink>
      </div>

      <div className="navbar-actions">
        <button type="button" className="nav-circle-btn" title="Search" onClick={() => navigate('/search')}>
          <Search size={18} />
        </button>
        <button type="button" className="nav-circle-btn" title="Saved" onClick={() => navigate('/bookmarks')}>
          <Bookmark size={18} />
        </button>
        <button
          type="button"
          className="nav-circle-btn"
          title="Notifications"
          style={{ position: 'relative' }}
          onClick={() => navigate('/notifications')}
        >
          <Bell size={18} />
          {unread > 0 && (
            <span style={{
              position: 'absolute', top: 2, right: 2, minWidth: 16, height: 16,
              borderRadius: 99, background: 'var(--fb-red)', color: '#fff',
              fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center',
              justifyContent: 'center', padding: '0 4px'
            }}>
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>
        <button type="button" className="nav-circle-btn" title="Plans" onClick={() => navigate('/subscriptions')}>
          <CreditCard size={18} />
        </button>

        {user && (
          <div className="points-display" style={{ fontSize: 13, height: 36 }} title="Your points">
            <Star size={14} fill="#F7B928" color="#F7B928" />
            {user.points || 0}
          </div>
        )}

        <div className="dropdown" ref={dropRef}>
          <button
            type="button"
            onClick={() => setDropdownOpen(!dropdownOpen)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', borderRadius: '50%' }}
            aria-label="Account"
          >
            {user?.avatar
              ? <img src={user.avatar} alt={user.name} className="avatar" />
              : <div className="avatar-placeholder">{initials}</div>
            }
          </button>

          {dropdownOpen && (
            <div className="dropdown-menu">
              <button
                type="button"
                className="dropdown-item"
                style={{ marginBottom: 4, padding: 8 }}
                onClick={() => {
                  navigate(`/profile/${user?._id || user?.id}`);
                  setDropdownOpen(false);
                }}
              >
                {user?.avatar
                  ? <img src={user.avatar} alt="" className="avatar" style={{ width: 36, height: 36 }} />
                  : <div className="avatar-placeholder" style={{ width: 36, height: 36, fontSize: 13 }}>{initials}</div>
                }
                <div>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{user?.name}</div>
                  <div style={{ fontSize: 13, color: 'var(--text-faint)' }}>See your profile</div>
                </div>
              </button>
              <div style={{ height: 1, background: 'var(--border-soft)', margin: '4px 0 8px' }} />
              <button type="button" className="dropdown-item" onClick={() => { navigate('/settings'); setDropdownOpen(false); }}>
                <Settings size={18} /> {t.settings}
              </button>
              <button type="button" className="dropdown-item" onClick={() => { navigate('/bookmarks'); setDropdownOpen(false); }}>
                <Bookmark size={18} /> Saved
              </button>
              <div style={{ height: 1, background: 'var(--border-soft)', margin: '4px 0' }} />
              <button type="button" className="dropdown-item danger" onClick={handleLogout}>
                <LogOut size={18} /> {t.logout}
              </button>
            </div>
          )}
        </div>

        <button className="hamburger" onClick={() => setMenuOpen(!menuOpen)} aria-label="Toggle menu">
          {menuOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>
    </nav>
  );
}
