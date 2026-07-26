'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

const vite = await createServer({
  root: new URL('..', import.meta.url).pathname,
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
});

test.after(async () => vite.close());

const presentation = await vite.ssrLoadModule('/src/features/runner/runnerConnectionPresentation.ts');

test('disconnected runner is never currently ready even if lastTestOk', () => {
  const runner = {
    status: 'active',
    connectionState: 'disconnected',
    lastTestOk: true,
    lastTestMessage: 'Connection test passed.',
  };
  assert.equal(presentation.isRunnerCurrentlyReady(runner), false);
  assert.equal(presentation.shouldShowReadyCard('ready', runner), false);
  assert.equal(presentation.shouldShowReconnectRequired(runner), true);
});

test('connected runner with lastTestOk is ready and may show ready card', () => {
  const runner = {
    status: 'active',
    connectionState: 'connected',
    lastTestOk: true,
    lastTestMessage: 'Connection test passed.',
  };
  assert.equal(presentation.isRunnerCurrentlyReady(runner), true);
  assert.equal(presentation.shouldShowReadyCard('ready', runner), true);
  assert.equal(presentation.shouldShowReconnectRequired(runner), false);
});

test('disconnected surfaces historical pass copy, not current readiness green pass', () => {
  const runner = {
    status: 'active',
    connectionState: 'disconnected',
    lastTestOk: true,
    lastTestMessage: 'Connection test passed. Runner is ready.',
  };
  const result = presentation.connectionTestPresentation(runner, 'Connection test passed. Runner is ready.');
  assert.equal(result.kind, 'historical_pass');
  assert.match(result.text, /마지막 연결 테스트는 통과했지만 현재는 연결되지 않았습니다/);
  assert.doesNotMatch(result.text, /^Connection test passed/);
  assert.doesNotMatch(result.text, /Runner가 Workspace에 연결되었습니다|작업 실행 준비가 완료되었습니다/);
});

test('connected surfaces current pass copy', () => {
  const runner = {
    status: 'active',
    connectionState: 'connected',
    lastTestOk: true,
    lastTestMessage: 'Runner가 Workspace에 연결되었습니다. 작업 실행 준비가 완료되었습니다.',
  };
  const result = presentation.connectionTestPresentation(runner);
  assert.equal(result.kind, 'current_pass');
  assert.match(result.text, /작업 실행 준비가 완료되었습니다/);
});

test('reconnect required copy constant is stable for E2E', () => {
  assert.equal(presentation.RECONNECT_REQUIRED_COPY, '다시 연결 필요');
});
