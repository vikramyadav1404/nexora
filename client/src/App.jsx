import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './context/AuthContext';
import Navbar from './components/Navbar';
import MobileNav from './components/MobileNav';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import Onboarding from './pages/Onboarding';
import Feed from './pages/Feed';
import QA from './pages/QA';
import QuestionDetail from './pages/QuestionDetail';
import AskQuestion from './pages/AskQuestion';
import Subscriptions from './pages/Subscriptions';
import Profile from './pages/Profile';
import Settings from './pages/Settings';
import Leaderboard from './pages/Leaderboard';
import SearchPage from './pages/Search';
import Notifications from './pages/Notifications';
import Spaces from './pages/Spaces';
import SpaceDetail from './pages/SpaceDetail';
import Bookmarks from './pages/Bookmarks';
import Challenges from './pages/Challenges';
import Terms from './pages/Terms';
import Privacy from './pages/Privacy';
import Admin from './pages/Admin';
import { useEffect } from 'react';

const ProtectedRoute = ({ children, requireOnboarding = true }) => {
  const { user, loading } = useAuth();
  if (loading) return (
    <div className="loading-screen">
      <div className="loading-logo">
        nexora<span />
      </div>
      <div className="spinner spinner-lg" />
    </div>
  );
  if (!user) return <Navigate to="/login" replace />;
  if (requireOnboarding && !user.onboardingCompleted) {
    return <Navigate to="/onboarding" replace />;
  }
  return children;
};

const PublicRoute = ({ children }) => {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return children;
  return <Navigate to={user.onboardingCompleted ? '/feed' : '/onboarding'} replace />;
};

const AppRoutes = () => {
  const { user } = useAuth();
  const showNav = user && user.onboardingCompleted;

  return (
    <>
      {showNav && <Navbar />}
      {showNav && <MobileNav />}
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
        <Route path="/register" element={<PublicRoute><Register /></PublicRoute>} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route
          path="/onboarding"
          element={
            <ProtectedRoute requireOnboarding={false}>
              <Onboarding />
            </ProtectedRoute>
          }
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
              boxShadow: '0 2px 12px rgba(0,0,0,0.15)'
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
