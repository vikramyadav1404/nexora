import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Navbar from './components/Navbar';
import MobileNav from './components/MobileNav';

// login flow loads first; everything else can wait
import Landing from './pages/Landing';
import Login from './pages/Login';
import Register from './pages/Register';

const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const Onboarding = lazy(() => import('./pages/Onboarding'));
const Feed = lazy(() => import('./pages/Feed'));
const QA = lazy(() => import('./pages/Questions'));
const QuestionDetail = lazy(() => import('./pages/QuestionDetail'));
const AskQuestion = lazy(() => import('./pages/AskQuestion'));
const Subscriptions = lazy(() => import('./pages/Subscriptions'));
const Profile = lazy(() => import('./pages/Profile'));
const Settings = lazy(() => import('./pages/Settings'));
const Leaderboard = lazy(() => import('./pages/Leaderboard'));
const SearchPage = lazy(() => import('./pages/Search'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Spaces = lazy(() => import('./pages/Spaces'));
const SpaceDetail = lazy(() => import('./pages/SpaceDetail'));
const Bookmarks = lazy(() => import('./pages/Bookmarks'));
const Challenges = lazy(() => import('./pages/Challenges'));
const Terms = lazy(() => import('./pages/Terms'));
const Privacy = lazy(() => import('./pages/Privacy'));
const Admin = lazy(() => import('./pages/Admin'));

const PAGE_TITLES = {
  '/': 'Home',
  '/login': 'Log in',
  '/register': 'Sign up',
  '/forgot-password': 'Forgot password',
  '/onboarding': 'Onboarding',
  '/feed': 'Feed',
  '/qa': 'Q&A',
  '/ask': 'Ask a question',
  '/subscriptions': 'Plans',
  '/settings': 'Settings',
  '/leaderboard': 'Leaderboard',
  '/search': 'Search',
  '/notifications': 'Notifications',
  '/spaces': 'Spaces',
  '/bookmarks': 'Bookmarks',
  '/challenges': 'Challenges',
  '/admin': 'Admin',
  '/terms': 'Terms',
  '/privacy': 'Privacy'
};

function RouteFallback() {
  return (
    <div className="loading-screen" role="status" aria-live="polite">
      <div className="loading-logo">
        nexora<span />
      </div>
      <div className="spinner spinner-lg" />
    </div>
  );
}

const ProtectedRoute = ({ children, requireOnboarding = true }) => {
  const { user, loading } = useAuth();
  if (loading) return <RouteFallback />;
  if (!user) return <Navigate to="/login" replace />;
  if (requireOnboarding && !user.onboardingCompleted) {
    return <Navigate to="/onboarding" replace />;
  }
  return children;
};

const PublicRoute = ({ children }) => {
  const { user, loading } = useAuth();
  if (loading) return <RouteFallback />;
  if (!user) return children;
  return <Navigate to={user.onboardingCompleted ? '/feed' : '/onboarding'} replace />;
};

function DocumentTitle() {
  const { pathname } = useLocation();
  useEffect(() => {
    let title = PAGE_TITLES[pathname];
    if (!title) {
      if (pathname.startsWith('/profile/')) title = 'Profile';
      else if (pathname.startsWith('/qa/')) title = 'Question';
      else if (pathname.startsWith('/spaces/')) title = 'Space';
      else title = 'Nexora';
    }
    document.title = title === 'Nexora' ? 'Nexora' : `${title} · Nexora`;
  }, [pathname]);
  return null;
}

const AppRoutes = () => {
  const { user } = useAuth();
  const showNav = user && user.onboardingCompleted;

  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      {showNav && <Navbar />}
      {showNav && <MobileNav />}
      <main id="main-content" className={showNav ? 'app-main' : undefined} tabIndex={-1}>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
            <Route path="/register" element={<PublicRoute><Register /></PublicRoute>} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route
              path="/onboarding"
              element={(
                <ProtectedRoute requireOnboarding={false}>
                  <Onboarding />
                </ProtectedRoute>
              )}
            />
            <Route path="/feed" element={<ProtectedRoute><Feed /></ProtectedRoute>} />
            <Route path="/qa" element={<ProtectedRoute><QA /></ProtectedRoute>} />
            <Route path="/qa/:id" element={<ProtectedRoute><QuestionDetail /></ProtectedRoute>} />
            <Route path="/ask" element={<ProtectedRoute><AskQuestion /></ProtectedRoute>} />
            <Route path="/subscriptions" element={<ProtectedRoute><Subscriptions /></ProtectedRoute>} />
            <Route path="/profile/:id" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
            <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
            <Route path="/leaderboard" element={<ProtectedRoute><Leaderboard /></ProtectedRoute>} />
            <Route path="/search" element={<ProtectedRoute><SearchPage /></ProtectedRoute>} />
            <Route path="/notifications" element={<ProtectedRoute><Notifications /></ProtectedRoute>} />
            <Route path="/spaces" element={<ProtectedRoute><Spaces /></ProtectedRoute>} />
            <Route path="/spaces/:id" element={<ProtectedRoute><SpaceDetail /></ProtectedRoute>} />
            <Route path="/bookmarks" element={<ProtectedRoute><Bookmarks /></ProtectedRoute>} />
            <Route path="/challenges" element={<ProtectedRoute><Challenges /></ProtectedRoute>} />
            <Route path="/admin" element={<ProtectedRoute><Admin /></ProtectedRoute>} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>
    </>
  );
};

function ThemeBoot() {
  useEffect(() => {
    const theme = localStorage.getItem('nexora_theme') || 'light';
    document.documentElement.setAttribute('data-theme', theme);
  }, []);
  return null;
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <ThemeBoot />
        <DocumentTitle />
        <AppRoutes />
        <Toaster
          position="bottom-center"
          toastOptions={{
            style: {
              background: 'var(--bg-surface)',
              color: 'var(--text-base)',
              border: '1px solid var(--border-soft)',
              borderRadius: '8px',
              fontSize: '14px',
              fontFamily: 'Helvetica, Arial, sans-serif',
              boxShadow: '0 2px 12px rgba(0, 0, 0, 0.15)'
            },
            success: { iconTheme: { primary: '#0866FF', secondary: '#fff' } },
            error: { iconTheme: { primary: '#F02849', secondary: '#fff' } }
          }}
        />
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
