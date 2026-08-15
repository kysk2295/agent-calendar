import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const desktopRoot = new URL('../', import.meta.url);
const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(desktopRoot),
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
});
const onboarding = await vite.ssrLoadModule('/src/features/onboarding/onboardingReadiness.ts');
const { OnboardingGuide } = await vite.ssrLoadModule('/src/features/onboarding/OnboardingGuide.tsx');

after(async () => {
  await vite.close();
});

test('every external setup choice can be explicitly skipped without synthesizing a Second Brain source', () => {
  const result = onboarding.buildOnboardingReadiness({
    skippedStepIds: ['calendar', 'wiki', 'mail', 'second_brain', 'calendar_ai', 'runner'],
  });

  assert.deepEqual(result.steps.map((step) => step.id), [
    'calendar',
    'wiki',
    'mail',
    'second_brain',
    'calendar_ai',
    'runner',
  ]);
  assert.equal(result.steps.every((step) => step.skipped === true), true);
  assert.equal(result.allReady, true);
  assert.equal(result.secondBrainSourceAvailable, false);
});

test('OnboardingGuide renders one explicit skip choice per unconnected setup step', () => {
  const stepIds = ['calendar', 'wiki', 'mail', 'second_brain', 'calendar_ai', 'runner'];
  const html = stepIds.map((activeStepId) => renderToStaticMarkup(createElement(OnboardingGuide, {
    readiness: onboarding.buildOnboardingReadiness({
      skippedStepIds: stepIds.filter((stepId) => stepId !== activeStepId),
    }),
    onConnectCalendar: async () => {},
    onSyncCalendar: async () => {},
    onOpenRunner: () => {},
    onOpenWiki: () => {},
    onOpenCalendarAi: () => {},
    onAddKnowledgeFile: async () => {},
    onDismiss: async () => {},
    onComplete: async () => {},
  }))).join('\n');

  assert.match(html, /내부 캘린더로 계속/);
  assert.match(html, /폴더 없이 계속/);
  assert.match(html, /Google 메일은 나중에 연결/);
  assert.match(html, /나중에 만들기/);
  assert.match(html, /제한된 상태로 계속/);
  assert.match(html, /실행 컴퓨터 없이 계속/);
  assert.doesNotMatch(html, /파악 중/);
});
