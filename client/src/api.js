/**
 * Shared axios defaults for Nexora API.
 * Dev: Vite proxies /api → localhost:5000
 * Prod: set VITE_API_URL=https://your-api.example.com
 */
import axios from 'axios';

const baseURL = import.meta.env.VITE_API_URL || '';

if (baseURL) {
  axios.defaults.baseURL = baseURL;
}

axios.defaults.headers.common['Content-Type'] = 'application/json';
axios.defaults.timeout = 30000;

// Attach token from storage on every request (survives hot reloads)
axios.interceptors.request.use((config) => {
  const token = localStorage.getItem('nexora_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Normalize error messages for toast UIs
axios.interceptors.response.use(
  (res) => res,
  (error) => {
    const message =
      error.response?.data?.message ||
      error.message ||
      'Something went wrong';
    error.friendlyMessage = message;
    return Promise.reject(error);
  }
);

export default axios;
export { baseURL };
