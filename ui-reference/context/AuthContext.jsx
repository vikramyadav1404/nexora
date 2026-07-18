import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState(() => localStorage.getItem('nexora_token'));

  // Set axios default header
  useEffect(() => {
    if (token) {
      axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    } else {
      delete axios.defaults.headers.common['Authorization'];
    }
  }, [token]);

  // Load user on mount
  useEffect(() => {
    if (token) {
      fetchMe();
    } else {
      setLoading(false);
    }
  }, []);

  const fetchMe = async () => {
    try {
      const res = await axios.get('/api/auth/me');
      setUser(res.data.user);
    } catch {
      logout();
    } finally {
      setLoading(false);
    }
  };

  const login = async (email, password) => {
    const res = await axios.post('/api/auth/login', { email, password });
    const { token: t, user: u } = res.data;
    localStorage.setItem('nexora_token', t);
    setToken(t);
    axios.defaults.headers.common['Authorization'] = `Bearer ${t}`;
    setUser(u);
    return u;
  };

  const register = async (name, email, phone, password) => {
    const res = await axios.post('/api/auth/register', { name, email, phone, password });
    const { token: t, user: u } = res.data;
    localStorage.setItem('nexora_token', t);
    setToken(t);
    axios.defaults.headers.common['Authorization'] = `Bearer ${t}`;
    setUser(u);
    return u;
  };

  const logout = () => {
    localStorage.removeItem('nexora_token');
    setToken(null);
    setUser(null);
    delete axios.defaults.headers.common['Authorization'];
  };

  const updateUser = useCallback((updates) => {
    setUser(prev => prev ? { ...prev, ...updates } : prev);
  }, []);

  const refreshUser = async () => {
    if (token) await fetchMe();
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, logout, updateUser, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
};
