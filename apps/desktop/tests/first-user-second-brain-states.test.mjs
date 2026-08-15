import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const desktopRoot = new URL('../', import.meta.url);
const vite = await createServer({
  appType: 'custom', root: fileURLToPath(desktopRoot),
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true },
});
const onboarding = await vite.ssrLoadModule('/src/features/onboarding/onboardingReadiness.ts');
const { SecondBrainOnboarding } = await vite.ssrLoadModule('/src/features/second-brain/SecondBrainOnboarding.tsx');

after(async () => { await vite.close(); });

test('folderless continue and other skips do not start a Second Brain run', () => {
  let starts = 0;
  const result = onboarding.buildOnboardingReadiness({
    skippedStepIds: ['calendar', 'wiki', 'mail'],
    secondBrainStatus: '',
  });
  assert.equal(result.secondBrainSourceAvailable, false);
  assert.equal(result.steps.find((step) => step.id === 'second_brain').ready, false);
  renderToStaticMarkup(createElement(SecondBrainOnboarding, {
    run: null, sourceAvailable: false, onStart: async () => { starts += 1; },
    onReview: async () => {}, onConnectCalendar: async () => {}, onOpenWiki: () => {},
  }));
  assert.equal(starts, 0);
});

test('source-required state never displays fabricated analysis progress', () => {
  const html = renderToStaticMarkup(createElement(SecondBrainOnboarding, {
    run: { id: 'run-1', status: 'source_required', stage: 'source_required', processed: 0, total: 0, sourceIds: [], snapshot: null },
    sourceAvailable: false, onStart: async () => {}, onReview: async () => {},
    onConnectCalendar: async () => {}, onOpenWiki: () => {},
  }));
  assert.match(html, /자료를 연결한 뒤 만들기/);
  assert.doesNotMatch(html, /파악 중|%|0\s*\/\s*0/);
});

test('only calendar, mail, and file origins can make onboarding source available', () => {
  for (const source of [
    { calendarSources: [{ id: 'c', provider: 'google', status: 'connected', lastSyncedAt: '2026-08-16' }] },
    { mailConnected: true },
    { knowledgeSources: [{ id: 'f', sourceKind: 'cloud_indexed', status: 'ready', path: 'notes.md' }] },
  ]) {
    assert.equal(onboarding.buildOnboardingReadiness(source).secondBrainSourceAvailable, true);
  }
  assert.equal(onboarding.buildOnboardingReadiness({
    knowledgeSources: [{ id: 'work-1', sourceKind: 'work_result', status: 'ready', path: 'report.md' }],
  }).secondBrainSourceAvailable, false);
});
