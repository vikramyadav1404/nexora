/**
 * Shared axios defaults for Nexora API.
 * Dev: Vite proxies /api → localhost:5000
 * Prod: set VITE_API_URL=https://your-api.example.com
 */
import axios from 'axios';

/** @type {string} */
const baseURL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

if (baseURL) {
  axios.defaults.baseURL = baseURL;
}

axios.defaults.headers.common['Content-Type'] = 'application/json';
axios.defaults.timeout = 30000;
axios.defaults.headers.common['X-Requested-With'] = 'XMLHttpRequest';

// Attach token from storage on every request (survives hot reloads)
axios.interceptors.request.use((config) => {
  const token = localStorage.getItem('nexora_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Normalize error messages for toast UIs; notify AuthContext on 401
axios.interceptors.response.use(
  (res) => res,
  (error) => {
    const status = error.response?.status;
    const message =
      error.response?.data?.message ||
      error.message ||
      'Something went wrong';
    error.friendlyMessage = message;

    if (status === 401 && localStorage.getItem('nexora_token')) {
      const url = error.config?.url || '';
      const isAuthAttempt =
        String(url).includes('/api/auth/login') ||
        String(url).includes('/api/auth/register');
      if (!isAuthAttempt) {
        localStorage.removeItem('nexora_token');
        // Sync React auth state (token clear alone left user stuck "logged in")
        window.dispatchEvent(new CustomEvent('nexora:logout'));
      }
    }
    return Promise.reject(error);
  }
);

export default axios;
export { baseURL };
