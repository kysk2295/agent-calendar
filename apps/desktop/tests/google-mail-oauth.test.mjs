import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { createServer } from 'vite';

const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const oauth = await vite.ssrLoadModule('/electron/deepLink.ts');
const mainSource = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
const deepLinkMainSource = await readFile(new URL('../electron/deepLinkMain.ts', import.meta.url), 'utf8');
const preloadSource = await readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8');
const preloadCtsSource = await readFile(new URL('../electron/preload.cts', import.meta.url), 'utf8');

after(async () => {
  await vite.close();
});

function response(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Google Mail OAuth stays in main and uses only mail authorize/callback endpoints', async () => {
  const requests = [];
  const opened = [];
  let sequence = 0;
  const coordinator = oauth.createDesktopGoogleMailOAuth({
    apiBaseUrl: () => 'https://calendar.example.test',
    getAccessToken: async () => 'workspace-access-token',
    createRequestId: () => `mail-request-${++sequence}`,
    openExternal: async (url) => opened.push(url),
    timeoutMs: 5_000,
    fetchImpl: async (url, init = {}) => {
      const pathname = new URL(String(url)).pathname;
      const headers = new Headers(init.headers);
      requests.push({
        pathname,
        authorization: headers.get('authorization'),
        requestId: headers.get('x-client-request-id'),
        idempotencyKey: headers.get('idempotency-key'),
        body: init.body ? JSON.parse(String(init.body)) : {},
      });
      if (pathname.endsWith('/authorize')) {
        return response(200, {
          ok: true,
          state: 'mail.state-1',
          authorizationUrl: 'https://accounts.google.test/o/oauth2/v2/auth?state=mail.state-1',
        });
      }
      if (pathname.endsWith('/callback')) {
        return response(200, {
          ok: true,
          connection: { provider: 'google', status: 'connected' },
        });
      }
      return response(404, { ok: false, error: 'not_found' });
    },
  });

  const pending = coordinator.begin();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(opened, [
    'https://accounts.google.test/o/oauth2/v2/auth?state=mail.state-1',
  ]);

  const result = await coordinator.handleCallback({
    kind: 'google-mail-callback',
    code: 'mail-code-1',
    state: 'mail.state-1',
  });
  assert.deepEqual(await pending, result);
  assert.deepEqual(result, {
    ok: true,
    connection: { provider: 'google', status: 'connected' },
  });
  assert.deepEqual(requests.map(({ pathname }) => pathname), [
    '/api/mail/google/authorize',
    '/api/mail/google/callback',
  ]);
  assert.equal(requests.every(({ authorization }) => authorization === 'Bearer workspace-access-token'), true);
  assert.deepEqual(requests.map(({ requestId, idempotencyKey }) => ({ requestId, idempotencyKey })), [
    { requestId: 'mail-request-1', idempotencyKey: null },
    { requestId: 'mail-request-2', idempotencyKey: 'mail-request-2' },
  ]);
  assert.deepEqual(requests[1].body, { code: 'mail-code-1', state: 'mail.state-1' });
  assert.equal(JSON.stringify(result).includes('mail-code-1'), false);
});

test('Google Mail callback deep links use a distinct strict namespace', () => {
  assert.deepEqual(
    oauth.parseAgentCalendarDeepLink('agent-calendar://mail/google/callback?code=mail-code&state=mail.state'),
    { kind: 'google-mail-callback', code: 'mail-code', state: 'mail.state' },
  );
  for (const invalid of [
    'agent-calendar://calendar/google/callback?code=mail-code&state=mail.state',
    'agent-calendar://mail/google/callback?code=mail-code&state=mail.state&extra=1',
    'agent-calendar://mail/google/callback?code=mail-code&state=mail.state#fragment',
    'agent-calendar://mail/google/callback?code=mail-code&code=other&state=mail.state',
  ]) {
    assert.notEqual(oauth.parseAgentCalendarDeepLink(invalid)?.kind, 'google-mail-callback');
  }
});

test('main owns the mail callback and exposes one dedicated trusted IPC', () => {
  assert.match(preloadSource, /connectGoogleMail: \(\) => ipcRenderer\.invoke\('mail:google-connect'\)/);
  assert.match(preloadCtsSource, /connectGoogleMail: \(\) => ipcRenderer\.invoke\('mail:google-connect'\)/);
  assert.match(mainSource, /registerTrustedIpcHandle\(ipcMain, 'mail:google-connect',[\s\S]*?googleMailOAuth\.begin\(\)\)/);
  assert.match(mainSource, /onGoogleMailCallback: \(target\) => handleGoogleMailCallbackDeepLink\(target\)/);
  assert.match(deepLinkMainSource, /target\.kind === 'google-mail-callback'[\s\S]*?onGoogleMailCallback/);
  assert.doesNotMatch(mainSource, /mail:google-connect'[\s\S]{0,160}googleCalendarOAuth\.begin/);
});
