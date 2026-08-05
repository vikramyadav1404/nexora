// axios setup — the API is same-origin (Vite proxy in dev, Vercel rewrite in prod)
import axios from 'axios';

/**
 * Base URL should normally be empty.
 *
 * The API is reached through a same-origin path: the Vite dev proxy locally,
 * the rewrites in client/vercel.json in production. That is what lets the
 * refresh cookie be SameSite=Strict. Pointing VITE_API_URL at the API's own
 * hostname would still "work" for requests while silently breaking every
 * refresh, because the cookie would no longer be same-site.
 */
const baseURL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

if (baseURL) {
  axios.defaults.baseURL = baseURL;
  if (import.meta.env.DEV) {
    console.warn(
      '[api] VITE_API_URL is set. The refresh cookie is SameSite=Strict and will ' +
      'not be sent cross-site — leave it empty and use the vercel.json rewrite.'
    );
  }
}

axios.defaults.timeout = 30000;
// The refresh token is an httpOnly cookie; without this axios never sends it.
axios.defaults.withCredentials = true;

/**
 * The access token lives here — a module variable, not localStorage.
 *
 * localStorage is readable by any script that ends up on the page, which makes
 * a long-lived token there worth stealing. This one is unreachable from other
 * scripts and dies with the tab; the httpOnly refresh cookie is what survives a
 * reload, and page script cannot read that at all.
 */
let accessToken = null;

export function setAccessToken(token) {
  accessToken = token || null;
}

export function getAccessToken() {
  return accessToken;
}

axios.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;

  // FormData needs the browser to set multipart boundary — don't force Content-Type
  if (typeof FormData !== 'undefined' && config.data instanceof FormData) {
    if (config.headers) {
      delete config.headers['Content-Type'];
      delete config.headers['content-type'];
    }
  } else if (config.data && typeof config.data === 'object' && !(config.data instanceof FormData)) {
    config.headers = config.headers || {};
    if (!config.headers['Content-Type'] && !config.headers['content-type']) {
      config.headers['Content-Type'] = 'application/json';
    }
  }
  return config;
});

/**
 * One refresh at a time.
 *
 * A page that fires several requests at once will see them all 401 together
 * when the 15-minute token lapses. Without this they would each start their own
 * refresh, and since rotation invalidates the previous token, the later ones
 * would present an already-revoked token — which the server correctly reads as
 * theft and responds to by revoking the whole family. The user would be logged
 * out simply for loading a busy page.
 *
 * So the first caller refreshes and the rest await the same promise.
 */
let refreshInFlight = null;

function refreshAccessToken() {
  refreshInFlight ||= axios
    .post('/api/auth/refresh', {}, { _skipAuthRetry: true })
    .then((res) => {
      setAccessToken(res.data.token);
      return res.data.token;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

export { refreshAccessToken };

axios.interceptors.response.use(
  (res) => res,
  async (error) => {
    const status = error.response?.status;
    const config = error.config || {};
    error.friendlyMessage =
      error.response?.data?.message || error.message || 'Something went wrong';

    const isAuthCall = /\/api\/auth\/(login|register|refresh)/.test(String(config.url || ''));

    // A 401 on a normal call means the access token expired. Refresh once and
    // replay. `_retried` stops a genuinely-unauthorised request from looping.
    if (status === 401 && !config._retried && !config._skipAuthRetry && !isAuthCall) {
      config._retried = true;
      try {
        await refreshAccessToken();
        return axios(config);
      } catch {
        setAccessToken(null);
        window.dispatchEvent(new CustomEvent('nexora:logout'));
        return Promise.reject(error);
      }
    }

    // Refresh itself failed: the session is genuinely over.
    if (status === 401 && (config._skipAuthRetry || isAuthCall) && !/login|register/.test(String(config.url || ''))) {
      setAccessToken(null);
      window.dispatchEvent(new CustomEvent('nexora:logout'));
    }

    return Promise.reject(error);
  }
);

export default axios;
export { baseURL };
