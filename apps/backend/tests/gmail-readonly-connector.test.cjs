'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createRealGoogleCalendarAdapter } = require('../app/lib/google-calendar-adapter');
const { handleScopedProductRoute } = require('../app/lib/production-product-routes');
const { matchProductionRoute } = require('../app/lib/production-route-registry');

function configuredAdapter() {
  return createRealGoogleCalendarAdapter({
    env: {
      GOOGLE_OAUTH_CLIENT_ID: 'client',
      GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
      GOOGLE_OAUTH_REDIRECT_URI: 'https://gateway.example/api/auth/google/callback',
    },
  });
}

test('Google Calendar and Gmail consent request separate minimum scopes', () => {
  const adapter = configuredAdapter();
  const calendar = new URL(adapter.getAuthorizationUrl({ state: 'calendar.state', purpose: 'calendar' }));
  const mail = new URL(adapter.getAuthorizationUrl({ state: 'mail.state', purpose: 'mail' }));

  assert.equal(calendar.searchParams.get('scope'), 'https://www.googleapis.com/auth/calendar');
  assert.equal(mail.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
  assert.doesNotMatch(calendar.searchParams.get('scope'), /gmail/);
  assert.doesNotMatch(mail.searchParams.get('scope'), /calendar/);
});

test('production exposes authenticated Gmail authorize and callback routes', () => {
  const authorize = matchProductionRoute('POST', '/api/mail/google/authorize')?.route;
  const callback = matchProductionRoute('POST', '/api/mail/google/callback')?.route;

  assert.deepEqual(
    [authorize?.class, authorize?.action, authorize?.role],
    ['scoped_product', 'mail_google_authorize', 'member'],
  );
  assert.deepEqual(
    [callback?.class, callback?.action, callback?.role],
    ['scoped_product', 'mail_google_callback', 'member'],
  );
});

test('Gmail routes delegate only to the mail connector boundary', async () => {
  const calls = [];
  const scope = { workspaceId: 'workspace-a', userId: 'user-a', role: 'member' };
  const runtime = {
    product: {},
    unifiedCalendar: {
      async startGoogleMailAuthorize(receivedScope) {
        calls.push(['authorize', receivedScope]);
        return { ok: true, state: 'mail.state', authorizationUrl: 'https://accounts.google.test/mail' };
      },
      async finalizeGoogleMailOAuth(receivedScope, payload) {
        calls.push(['callback', receivedScope, payload]);
        return { ok: true, connection: { provider: 'google', status: 'connected' } };
      },
      async startGoogleAuthorize() {
        assert.fail('Gmail must not start Calendar OAuth');
      },
    },
  };
  const response = () => ({
    status: 0,
    body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  });
  const invoke = async (action, body = {}) => {
    const res = response();
    const handled = await handleScopedProductRoute({
      req: {}, res, method: 'POST', pathname: '', params: {}, query: {}, body,
      route: { action }, scope, runtime,
    });
    assert.equal(handled, true);
    assert.equal(res.status, 200);
    return res.body;
  };

  const started = await invoke('mail_google_authorize');
  const completed = await invoke('mail_google_callback', { code: 'mail-code', state: 'mail.state' });

  assert.match(started.state, /^mail\./);
  assert.equal(completed.connection.status, 'connected');
  assert.deepEqual(calls, [
    ['authorize', scope],
    ['callback', scope, { code: 'mail-code', state: 'mail.state' }],
  ]);
});

test('Gmail read-only adapter returns bounded inbox metadata', async () => {
  const urls = [];
  const adapter = createRealGoogleCalendarAdapter({
    env: {
      GOOGLE_OAUTH_CLIENT_ID: 'client',
      GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
      GOOGLE_OAUTH_REDIRECT_URI: 'https://gateway.example/api/auth/google/callback',
    },
    credentialVault: {
      async getTokens() {
        return { accessToken: 'access', accessExpiresAt: new Date(Date.now() + 60_000).toISOString() };
      },
    },
    fetchImpl: async (url, options = {}) => {
      urls.push({ url: String(url), options });
      if (String(url).includes('/messages?')) {
        return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'm1', threadId: 't1' }] }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'm1',
          threadId: 't1',
          labelIds: ['INBOX', 'UNREAD'],
          internalDate: '1785456000000',
          snippet: '다음 주 회의 자료를 확인해 주세요.',
          payload: { headers: [
            { name: 'From', value: 'Sender <sender@example.com>' },
            { name: 'Subject', value: '회의 자료' },
            { name: 'Date', value: 'Fri, 31 Jul 2026 09:00:00 +0900' },
          ] },
        }),
      };
    },
  });

  const result = await adapter.listMailMessages({ credentialRef: 'cred-1', limit: 25 });

  assert.deepEqual(result.messages, [{
    id: 'm1',
    threadId: 't1',
    from: 'Sender <sender@example.com>',
    subject: '회의 자료',
    snippet: '다음 주 회의 자료를 확인해 주세요.',
    receivedAt: '2026-07-31T00:00:00.000Z',
    unread: true,
  }]);
  assert.match(urls[0].url, /maxResults=25/);
  assert.match(urls[0].url, /q=in%3Ainbox/);
  assert.equal(urls.every(({ options }) => options.headers.authorization === 'Bearer access'), true);
});

test('Google revoke uses only the selected Gmail credential refresh token', async () => {
  const requests = [];
  const removedCredentials = [];
  const adapter = createRealGoogleCalendarAdapter({
    env: {
      GOOGLE_OAUTH_CLIENT_ID: 'client',
      GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
      GOOGLE_OAUTH_REDIRECT_URI: 'https://gateway.example/api/auth/google/callback',
    },
    credentialVault: {
      async getTokens(credentialRef) {
        assert.equal(credentialRef, 'cred_google_mail_a');
        return { accessToken: 'mail-access-a', refreshToken: 'mail-refresh-a' };
      },
      async revoke(credentialRef) {
        removedCredentials.push(credentialRef);
      },
    },
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });

  await adapter.revoke({ credentialRef: 'cred_google_mail_a' });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://oauth2.googleapis.com/revoke');
  assert.equal(new URLSearchParams(requests[0].options.body).get('token'), 'mail-refresh-a');
  assert.deepEqual(removedCredentials, ['cred_google_mail_a']);
});

test('mail list returns connector truth from the authenticated user service', async () => {
  const calls = [];
  const scope = { workspaceId: 'workspace-a', userId: 'user-a', role: 'member' };
  const res = {
    status: 0,
    body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };

  await handleScopedProductRoute({
    req: {}, res, method: 'GET', pathname: '/api/mail/messages', params: {}, query: {}, body: {},
    route: { action: 'mail_list' }, scope,
    runtime: {
      product: {},
      unifiedCalendar: {
        async listMailMessages(receivedScope) {
          calls.push(receivedScope);
          return { ok: true, connector: 'connected', items: [{ id: 'm1' }], messages: [{ id: 'm1' }] };
        },
      },
    },
  });

  assert.deepEqual(calls, [scope]);
  assert.equal(res.status, 200);
  assert.equal(res.body.connector, 'connected');
  assert.equal(res.body.items[0].id, 'm1');
});
