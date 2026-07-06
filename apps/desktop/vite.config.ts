import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiProxyTarget = process.env.AGENT_CALENDAR_DEV_API_BASE_URL || 'https://hermes-os-production-e174.up.railway.app';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        secure: apiProxyTarget.startsWith('https://'),
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
