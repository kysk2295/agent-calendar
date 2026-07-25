import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const connectivity = await vite.ssrLoadModule('/src/features/connectivity/desktopConnectivity.ts');

after(async () => {
  await vite.close();
});

test('a failed hydrate preserves the last successful synchronization truth', () => {
  const firstSuccess = connectivity.markConnectivityOnline(
    connectivity.INITIAL_DESKTOP_CONNECTIVITY,
    '2026-07-25T01:00:00.000Z',
  );
  const offline = connectivity.markConnectivityOffline(firstSuccess, {
    at: '2026-07-25T01:01:00.000Z',
    message: 'Railway unavailable',
  });
  const repeatedFailure = connectivity.markConnectivityOffline(
    connectivity.beginConnectivityRetry(offline),
    {
      at: '2026-07-25T01:02:00.000Z',
      message: 'Railway still unavailable',
    },
  );

  assert.equal(firstSuccess.status, 'online');
  assert.equal(offline.status, 'offline');
  assert.equal(repeatedFailure.status, 'offline');
  assert.equal(repeatedFailure.lastSuccessfulAt, '2026-07-25T01:00:00.000Z');
  assert.equal(repeatedFailure.lastFailureAt, '2026-07-25T01:02:00.000Z');
  assert.equal(repeatedFailure.retryAttempt, 2);
  assert.equal(
    connectivity.connectivityPresentation(repeatedFailure).detail,
    '마지막 동기화 2026-07-25T01:00:00.000Z · 표시 중인 데이터는 유지됩니다.',
  );
});

test('only a successful retry produces a recovered state and advances synchronization time', () => {
  const offline = connectivity.markConnectivityOffline(
    connectivity.markConnectivityOnline(
      connectivity.INITIAL_DESKTOP_CONNECTIVITY,
      '2026-07-25T01:00:00.000Z',
    ),
    { at: '2026-07-25T01:01:00.000Z', message: 'offline' },
  );
  const retrying = connectivity.beginConnectivityRetry(offline);
  const recovered = connectivity.markConnectivityOnline(
    retrying,
    '2026-07-25T01:03:00.000Z',
  );

  assert.equal(retrying.status, 'reconnecting');
  assert.equal(retrying.lastSuccessfulAt, '2026-07-25T01:00:00.000Z');
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.lastSuccessfulAt, '2026-07-25T01:03:00.000Z');
  assert.equal(recovered.retryAttempt, 0);
  assert.deepEqual(connectivity.connectivityPresentation(recovered), {
    title: '다시 연결됨',
    detail: '최신 Workspace 상태로 동기화했습니다.',
    actionLabel: '',
  });
});

test('offline retry delay grows to a bounded maximum', () => {
  assert.equal(connectivity.offlineRetryDelayMs(0), 5_000);
  assert.equal(connectivity.offlineRetryDelayMs(1), 10_000);
  assert.equal(connectivity.offlineRetryDelayMs(2), 20_000);
  assert.equal(connectivity.offlineRetryDelayMs(3), 30_000);
  assert.equal(connectivity.offlineRetryDelayMs(20), 30_000);
});
