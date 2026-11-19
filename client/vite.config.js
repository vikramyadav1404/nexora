import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';

// proxy api/uploads to the local express server while developing
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:5000', changeOrigin: true },
      '/uploads': { target: 'http://localhost:5000', changeOrigin: true }
    }
  },
  test: {
    // e2e/ is Playwright's (npm run test:e2e), not vitest's.
    exclude: [...configDefaults.exclude, 'e2e/**']
  }
});
