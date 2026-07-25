import { EventEmitter } from 'node:events';

import type { DesktopUpdaterAdapter } from './desktopRelease.js';

export class DesktopReleaseFixtureUpdater extends EventEmitter implements DesktopUpdaterAdapter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = false;
  allowDowngrade = false;

  checkForUpdates(): Promise<unknown> {
    this.emit('checking-for-update');
    queueMicrotask(() => {
      this.emit('update-available', { version: '0.1.1' });
    });
    return Promise.resolve(null);
  }

  downloadUpdate(): Promise<unknown> {
    this.emit('download-progress', { percent: 38 });
    queueMicrotask(() => {
      this.emit('download-progress', { percent: 100 });
      this.emit('update-downloaded', { version: '0.1.1' });
    });
    return Promise.resolve([]);
  }

  quitAndInstall(): void {
    this.emit('fixture-install-requested');
  }
}
