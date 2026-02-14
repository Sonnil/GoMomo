import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/* ── Dev-server hardening (IPv4-deterministic) ──────────────
 * macOS can resolve "localhost" to ::1 (IPv6) before 127.0.0.1,
 * causing proxy targets and curl health-checks to hang when the
 * backend only listens on IPv4.  Pinning to 127.0.0.1 by default
 * eliminates the ambiguity.  Override via env vars when needed
 * (e.g. VITE_WIDGET_HOST=0.0.0.0 for container/remote access).
 */
const BACKEND_ORIGIN =
  process.env.VITE_BACKEND_ORIGIN ?? 'http://127.0.0.1:3000';
const WIDGET_HOST = process.env.VITE_WIDGET_HOST ?? '127.0.0.1';

export default defineConfig({
  // In production the widget SPA is served at /widget/ by the backend.
  // During local dev it runs at root /.
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    host: WIDGET_HOST,
    hmr: {
      host: WIDGET_HOST === '0.0.0.0' ? '127.0.0.1' : WIDGET_HOST,
    },
    proxy: {
      // Forward API + WebSocket + health to the backend
      '/api': {
        target: BACKEND_ORIGIN,
        changeOrigin: true,
      },
      '/ws': {
        target: BACKEND_ORIGIN,
        changeOrigin: true,
        ws: true,
      },
      '/health': {
        target: BACKEND_ORIGIN,
        changeOrigin: true,
      },
      '/twilio': {
        target: BACKEND_ORIGIN,
        changeOrigin: true,
      },
      '/handoff': {
        target: BACKEND_ORIGIN,
        changeOrigin: true,
      },
      '/debug': {
        target: BACKEND_ORIGIN,
        changeOrigin: true,
      },
    },
  },
});
