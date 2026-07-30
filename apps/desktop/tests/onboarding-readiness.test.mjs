import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const onboarding = await vite.ssrLoadModule('/src/features/onboarding/onboardingReadiness.ts');

after(async () => {
  await vite.close();
});

test('empty Workspace starts with Calendar and keeps every setup step actionable', () => {
  const result = onboarding.buildOnboardingReadiness();
  assert.equal(result.completedCount, 0);
  assert.equal(result.allReady, false);
  assert.equal(result.nextStepId, 'calendar');
  assert.deepEqual(result.steps.map((step) => step.title), [
    '캘린더 동기화',
    'Runner와 실행 엔진',
    'Wiki 지식 소스',
    'Calendar AI 확인',
  ]);
});

test('readiness comes from synchronized Calendar, live tested Runner engine, and active Wiki source', () => {
  const result = onboarding.buildOnboardingReadiness({
    calendarSources: [{
      id: 'calendar-a',
      provider: 'google',
      status: 'connected',
      lastSyncedAt: '2026-07-25T00:00:00.000Z',
    }],
    runners: [{
      id: 'runner-a',
      status: 'active',
      connectionState: 'connected',
      lastTestOk: true,
      capabilities: {
        engines: {
          codex: { available: true, status: 'ready', authStatus: 'authenticated' },
        },
      },
    }],
    knowledgeSources: [{ id: 'wiki-a', status: 'active' }],
    calendarAiAvailable: true,
  });

  assert.equal(result.completedCount, 4);
  assert.equal(result.allReady, true);
  assert.equal(result.steps.every((step) => step.ready), true);
});

test('stale or revoked capability evidence never marks setup ready', () => {
  const result = onboarding.buildOnboardingReadiness({
    calendarSources: [{ id: 'calendar-a', provider: 'google', status: 'connected' }],
    runners: [{
      id: 'runner-a',
      status: 'active',
      connectionState: 'disconnected',
      lastTestOk: true,
      capabilities: {
        engines: {
          codex: { available: true, status: 'ready', authStatus: 'authenticated' },
        },
      },
    }],
    knowledgeSources: [
      { id: 'wiki-a', status: 'revoked' },
      { id: 'wiki-b', status: 'pending' },
    ],
  });

  assert.equal(result.steps.find((step) => step.id === 'calendar')?.statusLabel, '동기화 필요');
  assert.equal(result.steps.find((step) => step.id === 'runner')?.ready, false);
  assert.equal(result.steps.find((step) => step.id === 'wiki')?.ready, false);
  assert.equal(result.steps.find((step) => step.id === 'calendar_ai')?.ready, false);
});

test('connected Runner with installed but unauthenticated engine stays actionable', () => {
  const result = onboarding.buildOnboardingReadiness({
    runners: [{
      id: 'runner-a',
      status: 'active',
      connectionState: 'connected',
      lastTestOk: false,
      capabilities: {
        engines: {
          codex: {
            available: true,
            status: 'available',
            version: '1.2.3',
            authStatus: 'missing',
          },
        },
      },
    }],
  });

  const runner = result.steps.find((step) => step.id === 'runner');
  assert.equal(runner?.ready, false);
  assert.equal(runner?.statusLabel, '실행 엔진 인증 필요');
  assert.equal(runner?.actionLabel, '엔진 인증 확인');
  assert.match(runner?.description || '', /에이전트 작업/);
});

test('built-in Calendar source does not replace the required Google connection', () => {
  const result = onboarding.buildOnboardingReadiness({
    calendarSources: [{
      id: 'calendar-internal',
      provider: 'internal',
      status: 'connected',
    }],
  });

  const calendar = result.steps.find((step) => step.id === 'calendar');
  assert.equal(calendar?.statusLabel, '연결 필요');
  assert.equal(calendar?.actionKind, 'calendar_connect');
  assert.equal(calendar?.actionLabel, 'Google Calendar 연결');
});

test('Runner is optional setup because Calendar AI and Wiki AI no longer need one', () => {
  const result = onboarding.buildOnboardingReadiness();
  const runner = result.steps.find((step) => step.id === 'runner');
  const others = result.steps.filter((step) => step.id !== 'runner');

  assert.equal(runner.optional, true, 'Runner is for Agent Work, not a precondition for AI');
  assert.match(runner.description, /에이전트 작업/);
  for (const step of others) {
    assert.notEqual(step.optional, true, `${step.id} stays required`);
  }
});

test('setup completes without a Runner once the required steps are ready', () => {
  const result = onboarding.buildOnboardingReadiness({
    calendarSources: [{
      provider: 'google',
      status: 'connected',
      lastSyncedAt: '2026-07-29T00:00:00.000Z',
    }],
    knowledgeSources: [{ status: 'active' }],
    calendarAiAvailable: true,
  });

  assert.equal(result.steps.find((step) => step.id === 'runner').ready, false);
  assert.equal(result.allReady, true, 'an optional step must not block 설정 완료');
  assert.equal(result.nextStepId, 'runner', 'the optional step is still offered');
});

test('Calendar AI readiness does not depend on a connected Runner', () => {
  const withoutRunner = onboarding.buildOnboardingReadiness({ calendarAiAvailable: true });
  assert.equal(withoutRunner.steps.find((step) => step.id === 'calendar_ai').ready, true);

  const unconfigured = onboarding.buildOnboardingReadiness();
  const step = unconfigured.steps.find((s) => s.id === 'calendar_ai');
  assert.equal(step.ready, false);
  assert.doesNotMatch(step.statusLabel, /실행 엔진/, 'the blocker is not a Runner engine anymore');
});
