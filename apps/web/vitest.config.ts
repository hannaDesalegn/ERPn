import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Frontend tests.
 *
 * A browser-like environment, because everything worth testing here is about what a session
 * gate renders and what a form sends. `jsdom` rather than a real browser: contract section 13.2
 * reserves "never mock it" for the database, where constraints and policies are the logic. The
 * DOM is not that, and a headless browser would buy nothing these tests assert.
 *
 * `fetch` is never mocked away wholesale. Each test that needs the network installs a stub that
 * records what was requested, so a test can assert that the frontend called the real endpoint
 * rather than that it produced the right shape by some other route.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirrors vite.config.ts. A test suite resolving imports differently from the build is a
    // suite that proves things about a bundle nobody ships.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.spec.{ts,tsx}'],
    css: false,
  },
});
