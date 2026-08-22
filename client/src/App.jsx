import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Navbar from './components/Navbar';
import EnvironmentBanner from './components/EnvironmentBanner';
import MobileNav from './components/MobileNav';
import ErrorBoundary from './components/ErrorBoundary';
import useScrollRestoration from './hooks/useScrollRestoration';
import useReducedMotion from './hooks/useReducedMotion';
import { incrementUnread } from './hooks/useUnreadCount';
import { subscribeToNotifications, unsubscribe as unsubscribeRealtime } from './services/realtime';
import { SkeletonList, SkeletonPostCard } from './components/ui';

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

/** Full-screen fallback — only for the auth gate, before we know who you are. */
function BootFallback() {
  return (
    <div className="loading-screen" role="status" aria-live="polite">
      <div className="loading-logo">
        nexora<span />
      </div>
      <div className="spinner spinner-lg" />
    </div>
  );
}

/**
 * Route-level fallback while a lazy chunk downloads.
 *
 * This used to be the same 100vh spinner as the auth gate, so every cold
 * navigation flashed a blank screen. A content-shaped skeleton keeps the
 * chrome in place and reads as fast rather than broken.
 */
function RouteFallback() {
  return (
    <div className="content-wrapper" style={{ maxWidth: 640 }}>
      <SkeletonList count={3} Item={SkeletonPostCard} />
    </div>
  );
}

const ProtectedRoute = ({ children, requireOnboarding = true }) => {
  const { user, loading } = useAuth();
  if (loading) return <BootFallback />;
  if (!user) return <Navigate to="/login" replace />;
  if (requireOnboarding && !user.onboardingCompleted) {
    return <Navigate to="/onboarding" replace />;
  }
  return children;
};

const PublicRoute = ({ children }) => {
  const { user, loading } = useAuth();
  if (loading) return <BootFallback />;
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

function ScrollManager() {
  useScrollRestoration();
  return null;
}

/**
 * Keeps the unread badge live.
 *
 * Without this, a notification arriving while you sit on a page stays invisible
 * until you navigate. No-ops when Supabase Realtime env vars are absent.
 */
function RealtimeBridge() {
  const { user } = useAuth();
  const userId = user?._id || user?.id;

  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    let stop = () => {};

    subscribeToNotifications(userId, () => incrementUnread(1)).then((fn) => {
      if (cancelled) fn();
      else stop = fn;
    });

    return () => {
      cancelled = true;
      stop();
      unsubscribeRealtime();
    };
  }, [userId]);

  return null;
}

/** Cross-fade + a few px of lift. Deliberately subtle — this fires constantly. */
function RouteTransition({ children }) {
  const reduced = useReducedMotion();
  if (reduced) return children;
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}

const AppRoutes = () => {
  const { user } = useAuth();
  const location = useLocation();
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
          <AnimatePresence mode="wait" initial={false}>
            <Routes location={location} key={location.pathname}>
              <Route path="/" element={<RouteTransition><Landing /></RouteTransition>} />
              <Route path="/login" element={<PublicRoute><RouteTransition><Login /></RouteTransition></PublicRoute>} />
              <Route path="/register" element={<PublicRoute><RouteTransition><Register /></RouteTransition></PublicRoute>} />
              <Route path="/forgot-password" element={<RouteTransition><ForgotPassword /></RouteTransition>} />
              <Route
                path="/onboarding"
                element={(
                  <ProtectedRoute requireOnboarding={false}>
                    <RouteTransition><Onboarding /></RouteTransition>
                  </ProtectedRoute>
                )}
              />
              <Route path="/feed" element={<ProtectedRoute><RouteTransition><Feed /></RouteTransition></ProtectedRoute>} />
              <Route path="/qa" element={<ProtectedRoute><RouteTransition><QA /></RouteTransition></ProtectedRoute>} />
              <Route path="/qa/:id" element={<ProtectedRoute><RouteTransition><QuestionDetail /></RouteTransition></ProtectedRoute>} />
              <Route path="/ask" element={<ProtectedRoute><RouteTransition><AskQuestion /></RouteTransition></ProtectedRoute>} />
              <Route path="/subscriptions" element={<ProtectedRoute><RouteTransition><Subscriptions /></RouteTransition></ProtectedRoute>} />
              <Route path="/profile/:id" element={<ProtectedRoute><RouteTransition><Profile /></RouteTransition></ProtectedRoute>} />
              <Route path="/settings" element={<ProtectedRoute><RouteTransition><Settings /></RouteTransition></ProtectedRoute>} />
              <Route path="/leaderboard" element={<ProtectedRoute><RouteTransition><Leaderboard /></RouteTransition></ProtectedRoute>} />
              <Route path="/search" element={<ProtectedRoute><RouteTransition><SearchPage /></RouteTransition></ProtectedRoute>} />
              <Route path="/notifications" element={<ProtectedRoute><RouteTransition><Notifications /></RouteTransition></ProtectedRoute>} />
              <Route path="/spaces" element={<ProtectedRoute><RouteTransition><Spaces /></RouteTransition></ProtectedRoute>} />
              <Route path="/spaces/:id" element={<ProtectedRoute><RouteTransition><SpaceDetail /></RouteTransition></ProtectedRoute>} />
              <Route path="/bookmarks" element={<ProtectedRoute><RouteTransition><Bookmarks /></RouteTransition></ProtectedRoute>} />
              <Route path="/challenges" element={<ProtectedRoute><RouteTransition><Challenges /></RouteTransition></ProtectedRoute>} />
              <Route path="/admin" element={<ProtectedRoute><RouteTransition><Admin /></RouteTransition></ProtectedRoute>} />
              <Route path="/terms" element={<RouteTransition><Terms /></RouteTransition>} />
              <Route path="/privacy" element={<RouteTransition><Privacy /></RouteTransition>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </AnimatePresence>
        </Suspense>
      </main>
    </>
  );
};

/**
 * The inline script in index.html already set data-theme before first paint.
 * This only keeps the tab's theme-color meta in sync when the user toggles.
 */
function ThemeSync() {
  useEffect(() => {
    const apply = () => {
      const theme = document.documentElement.getAttribute('data-theme') || 'light';
      const meta = document.querySelector('meta[name="theme-color"]:not([media])');
      if (meta) meta.setAttribute('content', theme === 'dark' ? '#0B0B0F' : '#FFFFFF');
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });
    return () => observer.disconnect();
  }, []);
  return null;
}

function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <BrowserRouter>
          <ThemeSync />
          <DocumentTitle />
          <ScrollManager />
          <RealtimeBridge />
          {/*
            * Above the routes, so no page can render without it and no page can
            * choose not to. Returns null in production, so this costs nothing
            * there. See components/EnvironmentBanner.jsx.
            */}
          <EnvironmentBanner />
          <AppRoutes />
          <Toaster
            position="bottom-center"
            containerStyle={{
              /* Clear the 58px mobile tab bar — toasts used to land on top of it */
              bottom: 'calc(72px + env(safe-area-inset-bottom, 0px))'
            }}
            toastOptions={{
              duration: 3200,
              style: {
                background: 'var(--bg-surface)',
                color: 'var(--text-base)',
                border: '1px solid var(--border-soft)',
                borderRadius: 'var(--r-lg)',
                fontSize: 'var(--fs-base)',
                fontFamily: 'var(--font-body)',
                fontWeight: 500,
                boxShadow: 'var(--shadow-lg)',
                padding: '10px 14px'
              },
              success: { iconTheme: { primary: 'var(--green)', secondary: 'var(--bg-surface)' } },
              error: { iconTheme: { primary: 'var(--red)', secondary: 'var(--bg-surface)' } }
            }}
          />
        </BrowserRouter>
      </AuthProvider>
    </ErrorBoundary>
  );
}

export default App;
