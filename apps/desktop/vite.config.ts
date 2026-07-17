import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiProxyTarget = process.env.AGENT_CALENDAR_DEV_API_BASE_URL || 'https://hermes-os-production-e174.up.railway.app';
const explicitBuildId = String(process.env.AGENT_CALENDAR_BUILD_ID || process.env.SOURCE_COMMIT || '').trim();
const desktopBuildId = (explicitBuildId || (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'development';
  }
})()).slice(0, 12);

export default defineConfig({
  base: './',
  define: {
    __AGENT_CALENDAR_BUILD_ID__: JSON.stringify(desktopBuildId),
  },
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
