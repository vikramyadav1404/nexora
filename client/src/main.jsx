import React from 'react';
import ReactDOM from 'react-dom/client';
import './services/api.js';
import App from './App.jsx';
import './styles/index.css';

const root = document.getElementById('root');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
