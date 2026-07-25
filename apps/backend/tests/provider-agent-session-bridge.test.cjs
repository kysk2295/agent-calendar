'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeCatalogResponse,
  normalizeProviderSession,
  normalizeSessionCatalogResponse,
  providerSessionFailureStatus,
} = require('../app/lib/provider-agent-session-bridge');

test('catalog response accepts public metadata and rejects credentials or host paths', () => {
  assert.deepEqual(normalizeCatalogResponse('codex', [{
    provider: 'codex',
    externalAgentId: 'researcher',
    displayName: 'Researcher',
    description: 'Checks sources',
    sourceKind: 'local_profile',
    capability: 'importable',
  }]), [{
    provider: 'codex',
    externalAgentId: 'researcher',
    displayName: 'Researcher',
    description: 'Checks sources',
    sourceKind: 'local_profile',
    capability: 'importable',
  }]);

  assert.throws(
    () => normalizeCatalogResponse('codex', [{
      provider: 'codex',
      externalAgentId: 'researcher',
      displayName: 'Researcher',
      token: 'must-not-store',
    }]),
    (error) => error && error.code === 'provider_catalog_private_data',
  );
  assert.throws(
    () => normalizeCatalogResponse('claude', [{
      provider: 'claude',
      externalAgentId: 'reviewer',
      displayName: '/Users/alice/private/reviewer',
    }]),
    (error) => error && error.code === 'provider_catalog_private_data',
  );
});

test('session catalog response keeps resumable public metadata and rejects private fields', () => {
  assert.deepEqual(normalizeSessionCatalogResponse('claude', [{
    provider: 'claude',
    externalSessionId: '00000000-0000-4000-8000-000000000005',
    title: 'Review session',
    updatedAt: '2026-07-25T10:00:00.000Z',
    status: 'available',
    sourceKind: 'local_session',
    capability: 'resumable',
  }]), [{
    provider: 'claude',
    externalSessionId: '00000000-0000-4000-8000-000000000005',
    title: 'Review session',
    updatedAt: '2026-07-25T10:00:00.000Z',
    status: 'available',
    sourceKind: 'local_session',
    capability: 'resumable',
  }]);

  assert.throws(
    () => normalizeSessionCatalogResponse('claude', [{
      provider: 'claude',
      externalSessionId: '00000000-0000-4000-8000-000000000005',
      title: 'Review session',
      cookie: 'must-not-store',
    }]),
    (error) => error && error.code === 'provider_catalog_private_data',
  );
});

test('provider session mapping keeps Workspace, agent, Runner and external session distinct', () => {
  const session = normalizeProviderSession({
    id: 'provider-session-a',
    workspaceId: 'ws-a',
    agentId: 'agent-a',
    runnerId: 'runner-a',
    missionId: 'mission-a',
    workConversationId: 'conversation-a',
    engine: 'claude',
    provider: 'claude',
    externalAgentId: 'reviewer',
    externalSessionId: '00000000-0000-4000-8000-000000000001',
    status: 'active',
    title: 'Review session',
    credential: 'must-not-store',
  });

  assert.deepEqual(session, {
    id: 'provider-session-a',
    workspaceId: 'ws-a',
    agentId: 'agent-a',
    runnerId: 'runner-a',
    missionId: 'mission-a',
    workConversationId: 'conversation-a',
    engine: 'claude',
    provider: 'claude',
    externalAgentId: 'reviewer',
    externalSessionId: '00000000-0000-4000-8000-000000000001',
    status: 'active',
    title: 'Review session',
    lastErrorCode: '',
  });
  assert.equal(JSON.stringify(session).includes('must-not-store'), false);
});

test('provider terminal errors never imply a silent new session', () => {
  assert.equal(providerSessionFailureStatus('auth_required'), 'auth_required');
  assert.equal(providerSessionFailureStatus('session_missing'), 'missing');
  assert.equal(providerSessionFailureStatus('session_deleted'), 'deleted');
  assert.equal(providerSessionFailureStatus('quota_exhausted'), 'quota_exhausted');
  assert.equal(providerSessionFailureStatus('temporary_network'), 'unavailable');
});
