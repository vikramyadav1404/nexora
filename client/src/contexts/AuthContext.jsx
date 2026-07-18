import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import axios from '../services/api';

const AuthContext = createContext(null);

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState(() => localStorage.getItem('nexora_token'));

  useEffect(() => {
    if (token) {
      axios.defaults.headers.common.Authorization = `Bearer ${token}`;
    } else {
      delete axios.defaults.headers.common.Authorization;
    }
  }, [token]);

  useEffect(() => {
    if (token) fetchMe();
    else setLoading(false);
    // only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchMe() {
    try {
      const res = await axios.get('/api/auth/me');
      setUser(res.data.user);
    } catch {
      localStorage.removeItem('nexora_token');
      setToken(null);
      setUser(null);
      delete axios.defaults.headers.common.Authorization;
    } finally {
      setLoading(false);
    }
  }

  async function login(email, password) {
    const res = await axios.post('/api/auth/login', { email, password });
    const { token: t, user: u } = res.data;
    localStorage.setItem('nexora_token', t);
    setToken(t);
    axios.defaults.headers.common.Authorization = `Bearer ${t}`;
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
    localStorage.setItem('nexora_token', t);
    setToken(t);
    axios.defaults.headers.common.Authorization = `Bearer ${t}`;
    setUser(u);

    return {
      ...u,
      _registerMeta: {
        devEmailOtp: res.data.devEmailOtp,
        message: res.data.message
      }
    };
  }

  const logout = useCallback(() => {
    localStorage.removeItem('nexora_token');
    setToken(null);
    setUser(null);
    delete axios.defaults.headers.common.Authorization;
  }, []);

  // api interceptor fires this when the token is dead
  useEffect(() => {
    const onLogout = () => logout();
    window.addEventListener('nexora:logout', onLogout);
    return () => window.removeEventListener('nexora:logout', onLogout);
  }, [logout]);

  const updateUser = useCallback((updates) => {
    setUser((prev) => (prev ? { ...prev, ...updates } : prev));
  }, []);

  async function refreshUser() {
    if (!localStorage.getItem('nexora_token')) return;
    try {
      const res = await axios.get('/api/auth/me');
      setUser(res.data.user);
    } catch (err) {
      if (err.response?.status === 401 || err.response?.status === 403) logout();
    }
  }

  return (
    <AuthContext.Provider
      value={{ user, token, loading, login, register, logout, updateUser, refreshUser }}
    >
      {children}
    </AuthContext.Provider>
  );
}
