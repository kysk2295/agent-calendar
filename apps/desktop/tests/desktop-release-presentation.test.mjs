import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const preload = fs.readFileSync(new URL('../electron/preload.cts', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const types = fs.readFileSync(new URL('../src/vite-env.d.ts', import.meta.url), 'utf8');

test('trusted desktop bridge exposes bounded release and recovery APIs', () => {
  for (const channel of [
    'desktop-release:status',
    'desktop-release:check',
    'desktop-release:download',
    'desktop-release:install',
    'desktop-recovery:consume',
  ]) {
    assert.match(preload, new RegExp(channel.replace(':', '\\:')));
  }
  assert.match(preload, /onDesktopReleaseStatus/);
  assert.match(types, /type HermesDesktopReleaseStatus/);
  assert.match(types, /type HermesDesktopRecoveryStatus/);
  assert.doesNotMatch(types, /releaseUrl|providerToken|rawError|stack/);
});

test('settings presents explicit update actions and renderer recovery truth', () => {
  assert.match(app, /data-testid="desktop-release-panel"/);
  assert.match(app, /data-testid="desktop-release-check"/);
  assert.match(app, /data-testid="desktop-release-download"/);
  assert.match(app, /data-testid="desktop-release-install"/);
  assert.match(app, /data-testid="desktop-recovery-notice"/);
  assert.match(app, /consumeDesktopRecoveryStatus/);
  assert.match(app, /onDesktopReleaseStatus/);
  assert.match(main, /nativeTheme\.themeSource/);
});
