import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // '@' points at src/. Absolute imports keep module paths stable when files
      // move, which matters in a layered app where features get reorganised.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    open: false,
    /**
     * The API, served from the same origin as the page.
     *
     * Not a convenience. The session cookie is SameSite=Strict and the server checks the origin
     * of every mutation, so a dev setup where the page is on one port and the API on another is
     * a setup where nothing works and the reason looks like a bug in the security code. In
     * production both sit behind one origin per section 15.6; this makes development match.
     */
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
    },
  },
})
