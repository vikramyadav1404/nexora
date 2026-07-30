import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The server is CommonJS; run tests in Node with globals off so each file
    // imports what it needs explicitly.
    environment: 'node',
    // .mjs so the test files are ESM (vitest can't be require()d) while the
    // server source stays CommonJS.
    include: ['test/**/*.test.mjs'],
    // Route modules read process.env at require time, and several tests mutate
    // it — isolate so one file's env can't leak into another's.
    isolate: true,
    pool: 'forks'
  }
});
