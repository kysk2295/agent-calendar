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

test('auth callback deep links accept only code+state on agent-calendar://auth/callback', () => {
  assert.deepEqual(
    deepLinkModule.parseAgentCalendarDeepLink(
      'agent-calendar://auth/callback?code=4%2F0Acv-google-code&state=xyz789',
    ),
    { kind: 'auth-callback', code: '4/0Acv-google-code', state: 'xyz789' },
  );

  const rejected = [
    'agent-calendar://auth/callback?code=abc&state=xyz&extra=1',
    'agent-calendar://auth/callback?code=abc',
    'agent-calendar://auth/callback?state=xyz',
    'agent-calendar://auth/callback?code=abc&state=xyz&code=dup',
    'agent-calendar://auth/callback?code=abc&state=has%2Fslash',
    'agent-calendar://user:pass@auth/callback?code=abc&state=xyz',
    'agent-calendar://auth:443/callback?code=abc&state=xyz',
    'agent-calendar://auth/callback?code=abc&state=xyz#frag',
    'agent-calendar://auth/other?code=abc&state=xyz',
    'https://auth/callback?code=abc&state=xyz',
  ];
  for (const value of rejected) {
    assert.equal(deepLinkModule.parseAgentCalendarAuthCallbackDeepLink(value), null, value);
  }
});

test('Google Calendar callback deep links use a distinct strict namespace', () => {
  assert.deepEqual(
    deepLinkModule.parseAgentCalendarDeepLink(
      'agent-calendar://calendar/google/callback?code=4%2F0Acv-calendar-code&state=calendar-state-1',
    ),
    {
      kind: 'google-calendar-callback',
      code: '4/0Acv-calendar-code',
      state: 'calendar-state-1',
    },
  );

  const rejected = [
    'agent-calendar://calendar/google/callback?code=abc&state=xyz&extra=1',
    'agent-calendar://calendar/google/callback?code=abc',
    'agent-calendar://calendar/google/callback?state=xyz',
    'agent-calendar://calendar/google/callback?code=abc&state=xyz&state=dup',
    'agent-calendar://calendar/google/callback?code=abc&state=has%2Fslash',
    'agent-calendar://user:pass@calendar/google/callback?code=abc&state=xyz',
    'agent-calendar://calendar:443/google/callback?code=abc&state=xyz',
    'agent-calendar://calendar/google/callback?code=abc&state=xyz#frag',
    'agent-calendar://calendar/google/other?code=abc&state=xyz',
    'agent-calendar://auth/callback?code=calendar-code&state=calendar-state',
    'https://calendar/google/callback?code=abc&state=xyz',
  ];
  for (const value of rejected) {
    assert.equal(
      deepLinkModule.parseAgentCalendarGoogleCallbackDeepLink(value),
      null,
      value,
    );
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

test('OAuth callback handling logs only callback shape, never raw code or state', () => {
  const sensitiveSources = [
    source('electron/deepLink.ts'),
    source('electron/deepLinkMain.ts'),
    source('../backend/app/lib/google-auth-callback-bridge.js'),
  ].join('\n');
  assert.doesNotMatch(
    sensitiveSources,
    /console\.(?:log|info|debug)\([^)]*(?:rawUrl|code|state|location)/s,
  );
});
