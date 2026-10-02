import { defineConfig } from 'vite';
import { isIP } from 'node:net';
import react from '@vitejs/plugin-react';
import { documentCsp } from './csp';

export default defineConfig({
  plugins: [react(), documentCsp()],
  cacheDir: process.env.VITE_CACHE_DIR ?? 'node_modules/.vite',
  // Worklet stays same-origin: no data: script permission in the document CSP.
  build: { assetsInlineLimit: file => file.endsWith('/audio-worklet.js') ? false : undefined },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    headers: {
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://backend:3001',
        changeOrigin: false,
        xfwd: false,
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest, request) => {
            for (const header of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']) {
              proxyRequest.removeHeader(header);
            }
            const peer = request.socket.remoteAddress;
            if (peer && isIP(peer) && !peer.includes('%')) proxyRequest.setHeader('X-Forwarded-For', peer);
          });
        },
      },
    },
  },
});
