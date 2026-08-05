import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import axios, { setAccessToken, getAccessToken, refreshAccessToken } from '../services/api';

const AuthContext = createContext(null);

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [token, setTokenState] = useState(null);

  const applyToken = useCallback((t) => {
    setAccessToken(t);
    setTokenState(t || null);
  }, []);

  /*
   * Bootstrap.
   *
   * The access token is in memory, so a reload starts with none. What survives
   * is the httpOnly refresh cookie, which page script cannot read — so instead
   * of reading a token we ask the server for a new one. A 401 here simply means
   * no valid session, which is the ordinary logged-out case, not an error.
   */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await refreshAccessToken();
        if (cancelled) return;
        const res = await axios.get('/api/auth/me');
        if (cancelled) return;
        setTokenState(getAccessToken());
        setUser(res.data.user);
      } catch {
        if (!cancelled) {
          applyToken(null);
          setUser(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [applyToken]);

  async function login(email, password) {
    const res = await axios.post('/api/auth/login', { email, password });
    const { token: t, user: u } = res.data;
    applyToken(t);
    setUser(u);
    return u;
  }

  async function register(payload) {
    // usually an object; keep a tiny fallback for older call styles
    const body =
      typeof payload === 'string'
        ? {
            name: payload,
            email: arguments[1],
            phone: arguments[2],
            password: arguments[3],
            gender: arguments[4]
          }
        : payload;

    const firstName = (body.firstName || '').trim();
    const middleName = (body.middleName || '').trim();
    const lastName = (body.lastName || '').trim();
    const name = (body.name || [firstName, middleName, lastName].filter(Boolean).join(' ')).trim();

    const res = await axios.post('/api/auth/register', {
      name,
      firstName,
      middleName,
      lastName,
      email: body.email,
      phone: body.phone,
      password: body.password,
      gender: body.gender
    });

    const { token: t, user: u } = res.data;
    applyToken(t);
    setUser(u);

    return {
      ...u,
      _registerMeta: {
        devEmailOtp: res.data.devEmailOtp,
        message: res.data.message
      }
    };
  }

  const logout = useCallback(async () => {
    // Tell the server first so the refresh token is revoked rather than left
    // valid for 30 days. Local state is cleared either way.
    try {
      await axios.post('/api/auth/logout');
    } catch {
      /* already gone, or offline — clearing locally is still correct */
    }
    setAccessToken(null);
    setTokenState(null);
    setUser(null);
  }, []);

  // The api interceptor fires this when refresh fails and the session is over.
  useEffect(() => {
    const onLogout = () => {
      setAccessToken(null);
      setTokenState(null);
      setUser(null);
    };
    window.addEventListener('nexora:logout', onLogout);
    return () => window.removeEventListener('nexora:logout', onLogout);
  }, []);

  const updateUser = useCallback((updates) => {
    setUser((prev) => (prev ? { ...prev, ...updates } : prev));
  }, []);

  const refreshUser = useCallback(async () => {
    if (!getAccessToken()) return;
    try {
      const res = await axios.get('/api/auth/me');
      setUser(res.data.user);
    } catch (err) {
      // A 401 has already been through the interceptor's refresh-and-retry, so
      // reaching here means the session really is finished.
      if (err.response?.status === 403) {
        setAccessToken(null);
        setTokenState(null);
        setUser(null);
      }
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, token, loading, login, register, logout, updateUser, refreshUser }}
    >
      {children}
    </AuthContext.Provider>
  );
}
