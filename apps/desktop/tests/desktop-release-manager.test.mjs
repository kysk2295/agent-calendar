import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const release = await vite.ssrLoadModule('/electron/desktopRelease.ts');

after(async () => {
  await vite.close();
});

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  checks = 0;
  downloads = 0;
  installs = 0;

  async checkForUpdates() {
    this.checks += 1;
    this.emit('checking-for-update');
    return null;
  }

  async downloadUpdate() {
    this.downloads += 1;
    return [];
  }

  quitAndInstall() {
    this.installs += 1;
  }
}

test('stable release manager configures explicit safe update policy and fails closed when unpackaged', async () => {
  const updater = new FakeUpdater();
  const manager = release.createDesktopReleaseManager({
    updater,
    currentVersion: '1.2.3',
    supported: false,
  });

  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(manager.getStatus().phase, 'unsupported');
  await assert.rejects(() => manager.check(), /packaged|지원하지/i);
  assert.equal(updater.checks, 0);
});

test('available update is checked once, downloaded explicitly, and installed only after ready', async () => {
  const updater = new FakeUpdater();
  const statuses = [];
  const manager = release.createDesktopReleaseManager({
    updater,
    currentVersion: '1.2.3',
    supported: true,
    onStatus: (status) => statuses.push(status),
  });

  const firstCheck = manager.check();
  const duplicateCheck = manager.check();
  assert.equal(firstCheck, duplicateCheck);
  await firstCheck;
  updater.emit('update-available', { version: '1.2.4', files: [{ url: 'https://secret.example/update.zip' }] });
  assert.equal(manager.getStatus().phase, 'available');
  assert.equal(manager.getStatus().availableVersion, '1.2.4');
  assert.doesNotMatch(JSON.stringify(manager.getStatus()), /secret\\.example/);

  await assert.rejects(() => manager.install(), /준비|ready/i);
  await manager.download();
  updater.emit('download-progress', { percent: 42.7, transferred: 10, total: 20 });
  assert.equal(manager.getStatus().phase, 'downloading');
  assert.equal(manager.getStatus().progressPercent, 43);
  updater.emit('update-downloaded', { version: '1.2.4' });
  assert.equal(manager.getStatus().phase, 'ready');
  await manager.install();

  assert.equal(updater.checks, 1);
  assert.equal(updater.downloads, 1);
  assert.equal(updater.installs, 1);
  assert.equal(statuses.at(-1).phase, 'installing');
});

test('provider errors expose bounded user copy without raw URL, token, or stack', async () => {
  const updater = new FakeUpdater();
  const manager = release.createDesktopReleaseManager({
    updater,
    currentVersion: '1.2.3',
    supported: true,
  });
  updater.emit('error', new Error('GET https://token.example/latest.yml?token=super-secret failed'));

  const status = manager.getStatus();
  assert.equal(status.phase, 'error');
  assert.match(status.message, /업데이트/);
  assert.doesNotMatch(JSON.stringify(status), /token\\.example|super-secret|latest\\.yml/);
});
