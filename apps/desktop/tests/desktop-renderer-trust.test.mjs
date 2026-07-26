import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  guardTrustedIpcEvent,
  guardTrustedIpcInvoke,
  installTrustedRendererNavigationGuard,
} from '../dist-electron/rendererTrust.js';

const root = new URL('../', import.meta.url);
const source = (path) => readFileSync(new URL(path, root), 'utf8');

test('renderer navigation guard prevents every untrusted main-frame navigation', () => {
  const webContents = new EventEmitter();
  installTrustedRendererNavigationGuard(
    webContents,
    (url) => url === 'file:///Applications/Agent%20Calendar.app/index.html',
  );

  const trustedEvent = { prevented: false, preventDefault() { this.prevented = true; } };
  webContents.emit(
    'will-navigate',
    trustedEvent,
    'file:///Applications/Agent%20Calendar.app/index.html',
  );
  assert.equal(trustedEvent.prevented, false);

  for (const url of [
    'https://attacker.example/',
    'file:///tmp/attacker.html',
    'javascript:alert(1)',
  ]) {
    for (const eventName of ['will-navigate', 'will-redirect']) {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      webContents.emit(eventName, event, url);
      assert.equal(event.prevented, true, `${eventName}:${url}`);
    }
  }
});

test('IPC guards reject untrusted invokes and ignore untrusted one-way messages', async () => {
  const calls = [];
  const authorize = (event) => {
    if (!event.trusted) throw new Error('untrusted renderer');
  };
  const invoke = guardTrustedIpcInvoke(authorize, async (_event, value) => {
    calls.push(value);
    return `accepted:${value}`;
  });
  const notify = guardTrustedIpcEvent(authorize, (_event, value) => {
    calls.push(value);
  });

  assert.throws(() => invoke({ trusted: false }, 'secret'), /untrusted renderer/);
  assert.equal(await invoke({ trusted: true }, 'read'), 'accepted:read');
  assert.doesNotThrow(() => notify({ trusted: false }, 'ignored'));
  notify({ trusted: true }, 'acknowledged');
  assert.deepEqual(calls, ['read', 'acknowledged']);
});

test('every preload IPC surface is registered through a trust guard', () => {
  const mainSource = source('electron/main.ts');
  const deepLinkMainSource = source('electron/deepLinkMain.ts');

  assert.match(mainSource, /installTrustedRendererNavigationGuard\(mainWindow\.webContents/);
  assert.match(mainSource, /installTrustedRendererNavigationGuard\(widgetOverlayWindow\.webContents/);
  assert.doesNotMatch(mainSource, /ipcMain\.handle\(/);
  assert.doesNotMatch(deepLinkMainSource, /ipcMain\.handle\(/);
  assert.match(deepLinkMainSource, /guardTrustedIpcEvent/);
});
