import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { createServer } from 'vite';

const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const deepLinkModule = await vite.ssrLoadModule('/electron/deepLink.ts');
const root = new URL('../', import.meta.url);
const source = (path) => readFileSync(new URL(path, root), 'utf8');

after(async () => {
  await vite.close();
});

test('session deep links accept one bounded public session identifier and reject other URLs', () => {
  assert.deepEqual(
    deepLinkModule.parseAgentCalendarDeepLink('agent-calendar://sessions/session-weekly-01'),
    { kind: 'session', sessionId: 'session-weekly-01' },
  );

  const rejected = [
    'https://sessions/session-weekly-01',
    'agent-calendar://reports/report-weekly-01',
    'agent-calendar://sessions/',
    'agent-calendar://sessions/session-one/extra',
    'agent-calendar://sessions/session-one%2Fextra',
    'agent-calendar://user:password@sessions/session-one',
    'agent-calendar://sessions/session-one?token=private',
    'agent-calendar://sessions/session-one#fragment',
    `agent-calendar://sessions/${'x'.repeat(201)}`,
  ];

  for (const value of rejected) {
    assert.equal(deepLinkModule.parseAgentCalendarDeepLink(value), null, value);
  }
});

test('cold launch selects the first valid Agent Calendar argument without coercing unrelated values', () => {
  assert.deepEqual(
    deepLinkModule.findAgentCalendarDeepLink([
      '/Applications/Agent Calendar.app/Contents/MacOS/Agent Calendar',
      '--flag',
      'agent-calendar://sessions/session-cold-start',
      'agent-calendar://sessions/session-ignored',
    ]),
    { kind: 'session', sessionId: 'session-cold-start' },
  );
  assert.equal(deepLinkModule.findAgentCalendarDeepLink(['Agent Calendar', '--flag']), null);
});

test('desktop packaging and renderer bridge own both cold and running deep-link paths', () => {
  const packageJson = JSON.parse(source('package.json'));
  const schemes = packageJson.build?.protocols?.flatMap((entry) => entry.schemes || []) || [];
  const integration = [
    source('electron/main.ts'),
    source('electron/deepLinkMain.ts'),
    source('electron/preload.cts'),
    source('src/vite-env.d.ts'),
    source('src/App.tsx'),
  ].join('\n');

  assert.deepEqual(schemes, ['agent-calendar']);
  assert.match(integration, /open-url/);
  assert.match(integration, /getPendingDeepLink/);
  assert.match(integration, /onDeepLink/);
  assert.match(integration, /useAgentCalendarDeepLink/);
});
