import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { createServer } from 'vite';

const { desktopLoginStartFailureMessage } = await import('../dist-electron/loginFailure.js');

const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const bridgeModule = await vite.ssrLoadModule('/src/api/desktopBridgeError.ts');

test('a gateway with no identity provider is reported as permanent, not as "try again"', () => {
  // The live gateway answers the Desktop login start with exactly this.
  const message = desktopLoginStartFailureMessage(503, 'WORKOS_CONFIG_MISSING');
  assert.match(message, /설정되어 있지 않습니다/);
  assert.doesNotMatch(message, /잠시 후 다시 시도/, 'retrying can never fix a missing provider');
});

test('a genuinely transient 503 still asks the user to retry', () => {
  const message = desktopLoginStartFailureMessage(503, 'UPSTREAM_TIMEOUT');
  assert.match(message, /잠시 후 다시 시도/);
});

test('other failures keep their code so the cause stays visible', () => {
  assert.match(desktopLoginStartFailureMessage(400, 'BAD_REQUEST'), /BAD_REQUEST/);
  assert.match(desktopLoginStartFailureMessage(500, ''), /500/);
});

test('Electron IPC transport text never reaches the user', () => {
  const { desktopBridgeErrorMessage } = bridgeModule;
  const raw = new Error(
    "Error invoking remote method 'auth:authkit-login': Error: 이 서버에 로그인 제공자가 설정되어 있지 않습니다.",
  );
  assert.equal(
    desktopBridgeErrorMessage(raw, '기본값'),
    '이 서버에 로그인 제공자가 설정되어 있지 않습니다.',
  );
  assert.equal(desktopBridgeErrorMessage(new Error('   '), '기본값'), '기본값');
  assert.equal(desktopBridgeErrorMessage(undefined, '기본값'), '기본값');
});

test.after(() => vite.close());
