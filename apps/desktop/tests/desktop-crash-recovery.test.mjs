import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const recovery = await vite.ssrLoadModule('/electron/desktopCrashRecovery.ts');

after(async () => {
  await vite.close();
});

test('two renderer crashes auto-reload but a third crash in five minutes opens safe recovery', () => {
  let now = Date.parse('2026-07-25T05:00:00.000Z');
  const controller = recovery.createDesktopCrashRecoveryController({
    now: () => now,
    windowMs: 5 * 60_000,
    maxAutomaticReloads: 2,
  });

  assert.equal(controller.record({ reason: 'crashed', exitCode: 1 }).action, 'reload');
  now += 10_000;
  assert.equal(controller.record({ reason: 'oom', exitCode: 9 }).action, 'reload');
  now += 10_000;
  const halted = controller.record({ reason: 'integrity-failure', exitCode: 10 });
  assert.equal(halted.action, 'fallback');
  assert.equal(halted.status.crashCount, 3);
  assert.equal(halted.status.phase, 'halted');
});

test('clean renderer exits are ignored and old crashes age out of the circuit window', () => {
  let now = 1_000_000;
  const controller = recovery.createDesktopCrashRecoveryController({
    now: () => now,
    windowMs: 60_000,
    maxAutomaticReloads: 1,
  });

  assert.equal(controller.record({ reason: 'clean-exit', exitCode: 0 }).action, 'ignore');
  assert.equal(controller.record({ reason: 'crashed', exitCode: 1 }).action, 'reload');
  now += 60_001;
  assert.equal(controller.record({ reason: 'crashed', exitCode: 1 }).action, 'reload');
});

test('recovery notice is consumed once and exposes no stack or private paths', () => {
  const controller = recovery.createDesktopCrashRecoveryController({ now: () => 10_000 });
  controller.record({ reason: 'crashed', exitCode: 1 });

  const status = controller.consumeStatus();
  assert.equal(status.phase, 'recovered');
  assert.equal(status.reason, 'crashed');
  assert.equal(controller.consumeStatus().phase, 'none');
  assert.doesNotMatch(JSON.stringify(status), /Users\/|stack|file:/i);
});
