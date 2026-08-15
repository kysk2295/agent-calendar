'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { runMigrations } = require('../app/db/migrate');
const { UnifiedCalendar } = require('../app/lib/unified-calendar');
const { resolveWorkspaceScope } = require('../app/lib/workspace-scope');
const { withEphemeralPostgres } = require('./support/ephemeral-postgres.cjs');

const VAULT_KEY = Buffer.alloc(32, 19).toString('base64');

test('Gmail OAuth state and stored connection stay bound to the initiating user', async () => {
  await withEphemeralPostgres({
    prefix: 'gmail-user-oauth-',
    role: 'gmail_user_oauth',
    database: 'gmail_user_oauth',
  }, async ({ pool }) => {
    await runMigrations({ pool });
    await pool.query(`insert into users (id, display_name, status) values
      ('mail-user-a', 'A', 'active'), ('mail-user-b', 'B', 'active')`);
    await pool.query(`insert into workspaces (id, name, status) values
      ('mail-workspace', 'Mail', 'active')`);
    await pool.query(`insert into workspace_memberships (id, user_id, workspace_id, role, status) values
      ('mail-membership-a', 'mail-user-a', 'mail-workspace', 'owner', 'active'),
      ('mail-membership-b', 'mail-user-b', 'mail-workspace', 'member', 'active')`);

    const listedCredentials = [];
    let mailListFailure = null;
    const google = {
      getAuthorizationUrl({ state, purpose }) {
        assert.equal(purpose, 'mail');
        return `https://accounts.google.test/oauth?state=${encodeURIComponent(state)}`;
      },
      async exchangeCode({ code, codeVerifier }) {
        assert.equal(code, 'mail-code-a');
        assert.ok(codeVerifier.length >= 43);
        return {
          ok: true,
          credentialRef: 'cred_google_mail_a',
          _vault: {
            accessToken: 'access-a',
            refreshToken: 'refresh-a',
            accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        };
      },
      async listMailMessages({ credentialRef }) {
        listedCredentials.push(credentialRef);
        if (mailListFailure) throw mailListFailure;
        return { ok: true, messages: [{ id: 'message-a', snippet: 'private-a', unread: true }] };
      },
    };
    const service = new UnifiedCalendar({
      pool,
      googleAdapter: google,
      env: {
        UNIFIED_CALENDAR_EXTERNAL_ENABLED: '1',
        GOOGLE_CREDENTIAL_ENCRYPTION_KEY: VAULT_KEY,
        GOOGLE_OAUTH_REDIRECT_URI: 'https://gateway.example/api/auth/google/callback',
      },
    });
    const scopeA = await resolveWorkspaceScope(pool, {
      workspaceId: 'mail-workspace', userId: 'mail-user-a',
    });
    const scopeB = await resolveWorkspaceScope(pool, {
      workspaceId: 'mail-workspace', userId: 'mail-user-b',
    });

    const started = await service.startGoogleMailAuthorize(scopeA);
    assert.match(started.state, /^mail\./);
    await assert.rejects(
      service.finalizeGoogleMailOAuth(scopeB, { code: 'mail-code-a', state: started.state }),
      (error) => error.code === 'OAUTH_STATE_UNKNOWN',
    );

    const completed = await service.finalizeGoogleMailOAuth(scopeA, {
      code: 'mail-code-a', state: started.state,
    });
    assert.equal(completed.connection.status, 'connected');

    const inboxA = await service.listMailMessages(scopeA);
    const inboxB = await service.listMailMessages(scopeB);
    assert.equal(inboxA.connector, 'connected');
    assert.equal(inboxA.items[0].id, 'message-a');
    assert.equal(inboxB.connector, 'not_linked');
    mailListFailure = Object.assign(new Error('grant expired'), { status: 401 });
    assert.equal((await service.listMailMessages(scopeA)).connector, 'reauthorization_required');
    assert.equal((await service.listMailMessages(scopeA)).connector, 'reauthorization_required');
    assert.deepEqual(listedCredentials, ['cred_google_mail_a', 'cred_google_mail_a']);
  });
});

test('Calendar and Gmail authorization states keep separate purposes', async () => {
  await withEphemeralPostgres({
    prefix: 'google-purpose-oauth-',
    role: 'google_purpose_oauth',
    database: 'google_purpose_oauth',
  }, async ({ pool }) => {
    await runMigrations({ pool });
    await pool.query(`insert into users (id, display_name, status)
      values ('purpose-user', 'Purpose', 'active')`);
    await pool.query(`insert into workspaces (id, name, status)
      values ('purpose-workspace', 'Purpose', 'active')`);
    await pool.query(`insert into workspace_memberships (id, user_id, workspace_id, role, status)
      values ('purpose-membership', 'purpose-user', 'purpose-workspace', 'owner', 'active')`);

    const purposes = [];
    const service = new UnifiedCalendar({
      pool,
      googleAdapter: {
        getAuthorizationUrl({ state, purpose }) {
          purposes.push(purpose);
          return `https://accounts.google.test/oauth?state=${encodeURIComponent(state)}`;
        },
      },
      env: {
        UNIFIED_CALENDAR_EXTERNAL_ENABLED: '1',
        GOOGLE_CREDENTIAL_ENCRYPTION_KEY: VAULT_KEY,
        GOOGLE_OAUTH_REDIRECT_URI: 'https://gateway.example/api/auth/google/callback',
      },
    });
    const scope = await resolveWorkspaceScope(pool, {
      workspaceId: 'purpose-workspace', userId: 'purpose-user',
    });

    const calendar = await service.startGoogleAuthorize(scope);
    const mail = await service.startGoogleMailAuthorize(scope);

    assert.match(calendar.state, /^calendar\./);
    assert.match(mail.state, /^mail\./);
    assert.deepEqual(purposes, ['calendar', 'mail']);
    await assert.rejects(
      service.finalizeGoogleOAuth(scope, { code: 'mail-code', state: mail.state }),
      (error) => error.code === 'OAUTH_PURPOSE_MISMATCH',
    );
    await assert.rejects(
      service.finalizeGoogleMailOAuth(scope, { code: 'calendar-code', state: calendar.state }),
      (error) => error.code === 'OAUTH_PURPOSE_MISMATCH',
    );
  });
});
