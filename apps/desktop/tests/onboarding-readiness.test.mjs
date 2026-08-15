import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const desktopRoot = new URL('../', import.meta.url);
const appSource = await readFile(new URL('src/App.tsx', desktopRoot), 'utf8');
const guideSource = await readFile(new URL('src/features/onboarding/OnboardingGuide.tsx', desktopRoot), 'utf8');
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
    '기록 연결 (선택)',
    'Google 메일 (선택)',
    '나를 이해하기',
    'Calendar AI 확인',
    '실행 컴퓨터 (선택)',
  ]);
  const runner = result.steps.find((step) => step.id === 'runner');
  assert.equal(runner?.statusLabel, '실행 컴퓨터 등록 필요');
  assert.equal(runner?.actionLabel, '실행 컴퓨터 연결');
  assert.match(runner?.description || '', /일회용 코드/);
  const calendar = result.steps.find((step) => step.id === 'calendar');
  assert.match(calendar?.description || '', /작업공간 로그인과 별도/);
  assert.match(calendar?.description || '', /브라우저/);
  assert.equal(calendar?.actionLabel, 'Google Calendar 연결');
});

test('active Workspace Runner completes only the Runner enrollment step', () => {
  const result = onboarding.buildOnboardingReadiness({
    runners: [{
      id: 'runner-a',
      status: 'active',
      connectionState: 'connected',
      lastTestOk: false,
    }],
  });

  assert.equal(result.completedCount, 1);
  assert.equal(result.allReady, false);
  assert.equal(result.steps.find((step) => step.id === 'runner')?.ready, true);
  assert.equal(result.steps.find((step) => step.id === 'runner')?.statusLabel, '실행 컴퓨터 등록 완료');
  assert.equal(result.steps.find((step) => step.id === 'calendar_ai')?.ready, false);
});

test('stale capability evidence does not complete sync, Wiki, or Calendar AI steps', () => {
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
  assert.equal(result.steps.find((step) => step.id === 'runner')?.ready, true);
  assert.equal(result.steps.find((step) => step.id === 'wiki')?.ready, false);
  assert.equal(result.steps.find((step) => step.id === 'calendar_ai')?.ready, false);
});

test('active but disconnected Runner stays actionable and asks to reconnect', () => {
  const result = onboarding.buildOnboardingReadiness({
    runners: [{
      id: 'runner-a',
      status: 'active',
      connectionState: 'disconnected',
      lastTestOk: true,
    }],
  });

  const runner = result.steps.find((step) => step.id === 'runner');
  assert.equal(runner?.ready, true);
  assert.equal(runner?.statusLabel, '실행 컴퓨터 등록 완료 · 현재 오프라인');
  assert.equal(runner?.actionLabel, '연결 확인');
  assert.match(runner?.description || '', /에이전트 작업|실행 컴퓨터|Runner/);
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

test('connected Google source without a completed sync stays honest and recoverable', () => {
  const result = onboarding.buildOnboardingReadiness({
    calendarSources: [{
      id: 'calendar-google',
      provider: 'google',
      status: 'connected',
      lastSyncedAt: '',
    }],
  });

  const calendar = result.steps.find((step) => step.id === 'calendar');
  assert.equal(calendar?.ready, false);
  assert.equal(calendar?.statusLabel, '동기화 필요');
  assert.equal(calendar?.actionKind, 'calendar_sync');
  assert.equal(calendar?.actionLabel, '지금 동기화');
});

test('completed desktop OAuth source truth replaces stale Google state without losing other sources', () => {
  const result = onboarding.mergeCalendarSourceTruth([
    { id: 'calendar-internal', provider: 'internal', status: 'connected' },
    { id: 'calendar-google', provider: 'google', status: 'syncing', lastSyncedAt: '' },
  ], {
    id: 'calendar-google',
    provider: 'google',
    status: 'connected',
    label: 'Google Calendar',
    lastSyncedAt: '2026-07-31T02:00:00.000Z',
  });

  assert.deepEqual(result, [
    { id: 'calendar-internal', provider: 'internal', status: 'connected' },
    {
      id: 'calendar-google',
      provider: 'google',
      status: 'connected',
      label: 'Google Calendar',
      lastSyncedAt: '2026-07-31T02:00:00.000Z',
    },
  ]);
});

test('Calendar AI conversation id alone never fakes readiness and recovery copy stays local-friendly', () => {
  const result = onboarding.buildOnboardingReadiness({
    calendarAiConversationId: 'stub-conversation',
  });

  const calendarAi = result.steps.find((step) => step.id === 'calendar_ai');
  assert.equal(calendarAi?.ready, false);
  assert.equal(calendarAi?.statusLabel, 'Calendar AI 준비 안 됨');
  assert.equal(calendarAi?.actionLabel, 'Calendar AI 화면 열기');
  assert.match(calendarAi?.description || '', /Google Calendar 동기화/);
  assert.match(calendarAi?.description || '', /로컬.*AI 실행 환경/);
  assert.doesNotMatch(calendarAi?.description || '', /Railway/);
  assert.equal(result.completedCount, 0);
});

test('synchronized Google Calendar makes Calendar AI usable through the honest fallback and updates progress', () => {
  const result = onboarding.buildOnboardingReadiness({
    calendarSources: [{
      id: 'calendar-google',
      provider: 'google',
      status: 'connected',
      lastSyncedAt: '2026-07-31T02:00:00.000Z',
    }],
  });

  const calendarAi = result.steps.find((step) => step.id === 'calendar_ai');
  assert.equal(calendarAi?.ready, true);
  assert.equal(calendarAi?.statusLabel, 'Calendar AI 사용 가능');
  assert.match(calendarAi?.description || '', /연결된 일정/);
  assert.equal(result.completedCount, 2);
  assert.equal(result.allReady, true);
  assert.equal(result.secondBrainSourceAvailable, true);
});

test('explicit Calendar AI availability completes the fourth setup step and N/4 progress', () => {
  const result = onboarding.buildOnboardingReadiness({
    calendarSources: [{
      id: 'calendar-google',
      provider: 'google',
      status: 'connected',
      lastSyncedAt: '2026-07-31T02:00:00.000Z',
    }],
    runners: [{ id: 'runner-ready', status: 'active' }],
    knowledgeSources: [{
      id: 'wiki-ready',
      status: 'ready',
      path: '/Users/example/Notes',
      sourceKind: 'private_local',
    }],
    calendarAiAvailable: true,
  });

  assert.equal(result.steps.find((step) => step.id === 'calendar_ai')?.ready, true);
  assert.equal(result.completedCount, 4);
  assert.equal(result.allReady, true);
});

test('a local folder can complete records without exposing a developer environment name', () => {
  const result = onboarding.buildOnboardingReadiness({
    wiki: {
      ok: true,
      source: 'local-wiki',
      wikiRoot: '/Users/example/Notes',
    },
  });
  const wiki = result.steps.find((step) => step.id === 'wiki');
  assert.equal(wiki?.ready, true);
  assert.match(wiki?.statusLabel || '', /로컬 폴더/);
  assert.doesNotMatch(wiki?.description || '', /LLM_WIKI_VAULT/);
  assert.equal(result.secondBrainSourceAvailable, true);
});

test('placeholder knowledge rows do not complete Wiki readiness', () => {
  const result = onboarding.buildOnboardingReadiness({
    knowledgeSources: [{ id: 'placeholder', status: 'active' }],
  });
  assert.equal(result.steps.find((step) => step.id === 'wiki')?.ready, false);
});
test('Calendar AI guide CTA opens the calendar surface and conversation panel explicitly', () => {
  assert.match(guideSource, /if \(actionKind === 'calendar_ai_open'\) onOpenCalendarAi\(\)/);
  assert.match(
    appSource,
    /onOpenCalendarAi=\{\(\) => \{\s*openScreen\('calendar'\);\s*setChatOpen\(true\);\s*\}\}/,
  );
});

test('records, mail, Second Brain, and the execution computer are optional setup choices', () => {
  const result = onboarding.buildOnboardingReadiness();
  const optionalIds = result.steps.filter((step) => step.optional).map((step) => step.id);

  assert.deepEqual(optionalIds, ['wiki', 'mail', 'second_brain', 'runner']);
  assert.match(result.steps.find((step) => step.id === 'runner').description, /에이전트 작업/);
});

test('setup completes without a Runner once the required steps are ready', () => {
  const result = onboarding.buildOnboardingReadiness({
    calendarSources: [{
      provider: 'google',
      status: 'connected',
      lastSyncedAt: '2026-07-29T00:00:00.000Z',
    }],
    knowledgeSources: [{
      id: 'wiki-ready',
      status: 'ready',
      path: '/Users/example/Notes',
      sourceKind: 'private_local',
    }],
    calendarAiAvailable: true,
  });

  assert.equal(result.steps.find((step) => step.id === 'runner').ready, false);
  assert.equal(result.allReady, true, 'an optional step must not block 설정 완료');
  assert.equal(result.nextStepId, 'mail', 'the next unconfigured optional choice is still offered');
});

test('Calendar AI readiness does not depend on a connected Runner', () => {
  const withoutRunner = onboarding.buildOnboardingReadiness({ calendarAiAvailable: true });
  assert.equal(withoutRunner.steps.find((step) => step.id === 'calendar_ai').ready, true);

  const unconfigured = onboarding.buildOnboardingReadiness();
  const step = unconfigured.steps.find((s) => s.id === 'calendar_ai');
  assert.equal(step.ready, false);
  assert.doesNotMatch(step.statusLabel, /실행 엔진/, 'the blocker is not a Runner engine anymore');
});
