import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const banner = await vite.ssrLoadModule('/src/features/connectivity/globalApiBanner.ts');

after(async () => {
  await vite.close();
});

test('expected local gateway fallback does not look like a Railway outage', () => {
  assert.equal(banner.shouldShowGlobalApiBanner({
    apiError: 'Agent Operations 불러오기 실패',
    screen: 'calendar',
    connectivityStatus: 'online',
    gatewayStatus: {
      gatewayFallback: true,
      runtimeReachable: false,
    },
  }), false);
});

test('a real API failure still shows the Railway warning', () => {
  assert.equal(banner.shouldShowGlobalApiBanner({
    apiError: 'Agents Calendar API 503 /api/tasks',
    screen: 'calendar',
    connectivityStatus: 'online',
    gatewayStatus: {
      gatewayFallback: false,
      runtimeReachable: false,
    },
  }), true);
});

test('runtime offline alone is not enough to suppress a real API failure', () => {
  assert.equal(banner.shouldShowGlobalApiBanner({
    apiError: 'Agents Calendar API 500 /api/state',
    screen: 'calendar',
    connectivityStatus: 'online',
    gatewayStatus: {
      runtimeReachable: false,
    },
  }), true);
});
