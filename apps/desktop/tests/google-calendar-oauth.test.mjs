import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { createServer } from 'vite';

const vite = await createServer({
  appType: 'custom',
  root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true, hmr: false },
});
const oauth = await vite.ssrLoadModule('/electron/deepLink.ts');

after(async () => {
  await vite.close();
});

function response(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createHappyHarness() {
  const requests = [];
  const opened = [];
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : {};
    requests.push({
      pathname,
      method: init.method || 'GET',
      authorization: new Headers(init.headers).get('authorization'),
      body,
    });
    if (pathname.endsWith('/authorize')) {
      return response(200, {
        ok: true,
        state: 'calendar-state-1',
        authorizationUrl: 'https://accounts.google.test/o/oauth2/v2/auth?state=calendar-state-1',
      });
    }
    if (pathname.endsWith('/callback')) {
      return response(200, {
        ok: true,
        source: {
          id: 'source-google-1',
          provider: 'google',
          status: 'connected',
          label: 'Google Calendar',
        },
      });
    }
    if (pathname.endsWith('/sync')) {
      return response(200, { ok: true, synced: 3 });
    }
    if (pathname.endsWith('/sources')) {
      return response(200, {
        ok: true,
        sources: [
          {
            id: 'source-internal-1',
            provider: 'internal',
            status: 'connected',
            label: 'Agent Calendar',
            lastSyncedAt: '',
          },
          {
            id: 'source-google-1',
            provider: 'google',
            status: 'connected',
            label: 'Google Calendar',
            lastSyncedAt: '2026-07-25T01:00:00.000Z',
          },
        ],
      });
    }
    return response(404, { ok: false, error: 'not_found' });
  };
  const coordinator = oauth.createDesktopGoogleCalendarOAuth({
    apiBaseUrl: () => 'https://calendar.example.test',
    getAccessToken: async () => 'workspace-access-token',
    fetchImpl,
    openExternal: async (url) => {
      opened.push(url);
    },
    timeoutMs: 5_000,
  });
  return { coordinator, requests, opened };
}

test('Google Calendar OAuth stays in main, finalizes once, syncs, and returns public source truth', async () => {
  const { coordinator, requests, opened } = createHappyHarness();
  const pending = coordinator.begin();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(opened, [
    'https://accounts.google.test/o/oauth2/v2/auth?state=calendar-state-1',
  ]);
  assert.equal(coordinator.getPendingState(), 'calendar-state-1');

  const result = await coordinator.handleCallback({
    kind: 'google-calendar-callback',
    code: 'calendar-code-1',
    state: 'calendar-state-1',
  });
  assert.deepEqual(await pending, result);
  assert.deepEqual(result, {
    ok: true,
    source: {
      id: 'source-google-1',
      provider: 'google',
      label: 'Google Calendar',
      status: 'connected',
      lastSyncedAt: '2026-07-25T01:00:00.000Z',
    },
    sync: { ok: true },
  });
  assert.deepEqual(
    requests.map((request) => request.pathname),
    [
      '/api/calendar/sources/google/authorize',
      '/api/calendar/sources/google/callback',
      '/api/calendar/sources/source-google-1/sync',
      '/api/calendar/sources',
    ],
  );
  assert.equal(
    requests.every((request) => request.authorization === 'Bearer workspace-access-token'),
    true,
  );
  assert.deepEqual(requests[1].body, {
    code: 'calendar-code-1',
    state: 'calendar-state-1',
  });
  assert.equal(JSON.stringify(result).includes('calendar-code-1'), false);
  assert.equal(JSON.stringify(result).includes('calendar-state-1'), false);
  assert.equal(JSON.stringify(result).includes('workspace-access-token'), false);
});

test('wrong state never finalizes and the valid callback can still complete the pending attempt', async () => {
  const { coordinator, requests } = createHappyHarness();
  const pending = coordinator.begin();
  await new Promise((resolve) => setTimeout(resolve, 0));

  await assert.rejects(
    coordinator.handleCallback({
      kind: 'google-calendar-callback',
      code: 'forged-code',
      state: 'forged-state',
    }),
    /state 검증/,
  );
  assert.equal(
    requests.filter((request) => request.pathname.endsWith('/callback')).length,
    0,
  );
  assert.equal(coordinator.getPendingState(), 'calendar-state-1');

  await coordinator.handleCallback({
    kind: 'google-calendar-callback',
    code: 'calendar-code-1',
    state: 'calendar-state-1',
  });
  await pending;
  assert.equal(
    requests.filter((request) => request.pathname.endsWith('/callback')).length,
    1,
  );
});

test('starting again cancels the first local attempt without finalizing either callback', async () => {
  const { coordinator, requests } = createHappyHarness();
  const first = coordinator.begin();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = coordinator.begin();
  await assert.rejects(first, /이전 Google Calendar 연결 시도가 취소/);
  await new Promise((resolve) => setTimeout(resolve, 0));

  coordinator.cancel();
  await assert.rejects(second, /취소/);
  assert.equal(
    requests.filter((request) => request.pathname.endsWith('/callback')).length,
    0,
  );
});

test('missing secure session and backend OAuth configuration fail closed before callback', async () => {
  let fetchCount = 0;
  let openCount = 0;
  const signedOut = oauth.createDesktopGoogleCalendarOAuth({
    apiBaseUrl: () => 'https://calendar.example.test',
    getAccessToken: async () => null,
    fetchImpl: async () => {
      fetchCount += 1;
      return response(500, {});
    },
    openExternal: async () => {
      openCount += 1;
    },
  });
  await assert.rejects(signedOut.begin(), /로그인이 필요/);
  assert.equal(fetchCount, 0);
  assert.equal(openCount, 0);

  const unconfigured = oauth.createDesktopGoogleCalendarOAuth({
    apiBaseUrl: () => 'https://calendar.example.test',
    getAccessToken: async () => 'workspace-access-token',
    fetchImpl: async () => response(503, {
      ok: false,
      error: 'GOOGLE_OAUTH_NOT_CONFIGURED',
      message: 'google oauth not configured',
    }),
    openExternal: async () => {
      openCount += 1;
    },
  });
  await assert.rejects(
    unconfigured.begin(),
    (error) => (
      error?.code === 'GOOGLE_OAUTH_NOT_CONFIGURED'
      && /Google Calendar 연결을 사용할 수 없습니다/.test(error.message)
    ),
  );
  assert.equal(openCount, 0);
});
