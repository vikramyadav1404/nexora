// axios setup — local dev uses the Vite proxy, prod uses VITE_API_URL
import axios from 'axios';

const baseURL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

if (baseURL) {
  axios.defaults.baseURL = baseURL;
}

axios.defaults.headers.common['Content-Type'] = 'application/json';
axios.defaults.timeout = 30000;

// stick the jwt on every request if we have one
axios.interceptors.request.use((config) => {
  const token = localStorage.getItem('nexora_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

axios.interceptors.response.use(
  (res) => res,
  (error) => {
    const status = error.response?.status;
    error.friendlyMessage =
      error.response?.data?.message || error.message || 'Something went wrong';

    // expired / invalid token — kick the user out cleanly
    if (status === 401 && localStorage.getItem('nexora_token')) {
      const url = String(error.config?.url || '');
      if (!url.includes('/api/auth/login') && !url.includes('/api/auth/register')) {
        localStorage.removeItem('nexora_token');
        window.dispatchEvent(new CustomEvent('nexora:logout'));
      }
    }
    return Promise.reject(error);
  }
);

export default axios;
export { baseURL };
