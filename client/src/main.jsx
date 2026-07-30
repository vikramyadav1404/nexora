import React from 'react';
import ReactDOM from 'react-dom/client';
import './services/api.js';
// Self-hosted variable font — one file covers 100–900, no network round trip
import '@fontsource-variable/inter';
import App from './App.jsx';
import './styles/index.css';
// Loaded after index.css so primitives win where they deliberately override
import './styles/primitives.css';

const root = document.getElementById('root');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
