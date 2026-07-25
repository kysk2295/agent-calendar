import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const runnerApi = await vite.ssrLoadModule('/src/features/runner/runnerApi.ts');

after(async () => {
  await vite.close();
});

test('engine presentation separates installation from Runner-hosted authentication', () => {
  assert.deepEqual(
    runnerApi.engineAuthenticationPresentation({
      installed: true,
      available: false,
      status: 'auth_required',
      version: '1.2.3',
      authStatus: 'missing',
    }),
    {
      state: 'auth_required',
      availabilityLabel: '설치됨 · 인증 필요',
      authLabel: 'Runner에서 로그인하세요',
      ready: false,
    },
  );

  assert.deepEqual(
    runnerApi.engineAuthenticationPresentation({
      installed: true,
      available: true,
      status: 'available',
      version: '1.2.3',
      authStatus: 'authenticated',
    }),
    {
      state: 'authenticated',
      availabilityLabel: '설치됨 · 1.2.3',
      authLabel: 'Runner 인증 확인됨',
      ready: true,
    },
  );
});
