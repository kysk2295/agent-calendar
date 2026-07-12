import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiProxyTarget = process.env.AGENT_CALENDAR_DEV_API_BASE_URL || 'https://hermes-os-production-e174.up.railway.app';

function readLocalDesktopApiToken() {
  const explicitToken = String(process.env.AGENT_CALENDAR_DEV_API_TOKEN || '').trim();
  if (explicitToken) return explicitToken;
  const localSettingsPath = path.join(os.homedir(), 'Library', 'Application Support', 'Agent Calendar', 'settings.json');
  try {
    const settings: unknown = JSON.parse(fs.readFileSync(localSettingsPath, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return '';
    const token = Reflect.get(settings, 'apiToken');
    return typeof token === 'string' ? token.trim() : '';
  } catch (error) {
    if (error instanceof Error) return '';
    throw error;
  }
}

const apiProxyToken = readLocalDesktopApiToken();

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
        headers: apiProxyToken ? { authorization: `Bearer ${apiProxyToken}` } : undefined,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
