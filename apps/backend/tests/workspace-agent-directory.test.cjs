'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeWorkspaceAgent,
  projectWorkspaceAgent,
} = require('../app/lib/workspace-agent-directory');

test('native Workspace agents keep responsibility fields and never persist credentials', () => {
  const agent = normalizeWorkspaceAgent({
    displayName: '리서치 파트너',
    role: '시장 리서처',
    responsibility: '매주 경쟁사 변화를 조사한다.',
    instructions: '사실과 추정을 구분한다.',
    specialties: ['시장 조사', '출처 검증'],
    defaultExecutionEngine: 'codex',
    apiKey: 'must-not-store',
    token: 'must-not-store',
    credentials: { cookie: 'must-not-store' },
  }, {
    id: 'agent-native-a',
    workspaceId: 'ws-a',
  });

  assert.deepEqual(agent, {
    id: 'agent-native-a',
    displayName: '리서치 파트너',
    name: '리서치 파트너',
    role: '시장 리서처',
    responsibility: '매주 경쟁사 변화를 조사한다.',
    instructions: '사실과 추정을 구분한다.',
    specialties: ['시장 조사', '출처 검증'],
    sourceKind: 'native',
    provider: 'agent-calendar',
    externalAgentId: '',
    syncMode: 'managed',
    connectionStatus: 'ready',
    defaultExecutionEngine: 'codex',
    defaultRunnerId: '',
    enabled: true,
    workspaceId: 'ws-a',
  });
  assert.equal(JSON.stringify(agent).includes('must-not-store'), false);
});

test('connected agents require a provider and external identity but no provider credential', () => {
  const agent = normalizeWorkspaceAgent({
    displayName: 'Hermes Researcher',
    role: '리서처',
    sourceKind: 'connected',
    provider: 'hermes',
    externalAgentId: 'researcher',
    apiKey: 'must-not-store',
  }, {
    id: 'agent-connected-a',
    workspaceId: 'ws-a',
  });

  assert.equal(agent.sourceKind, 'connected');
  assert.equal(agent.provider, 'hermes');
  assert.equal(agent.externalAgentId, 'researcher');
  assert.equal(agent.syncMode, 'reference');
  assert.equal(agent.connectionStatus, 'linked');
  assert.equal(JSON.stringify(agent).includes('must-not-store'), false);

  assert.throws(
    () => normalizeWorkspaceAgent({
      displayName: 'Broken',
      sourceKind: 'connected',
      provider: 'hermes',
    }, { id: 'broken', workspaceId: 'ws-a' }),
    (error) => error && error.code === 'agent_source_invalid' && error.statusHint === 422,
  );
});

test('legacy agent payloads receive a stable public directory projection', () => {
  const projected = projectWorkspaceAgent({
    id: 'legacy',
    name: 'Legacy Agent',
    role: 'operator',
    source: 'hermes-cli',
    status: 'Active',
    workspaceId: 'ws-a',
  });

  assert.equal(projected.displayName, 'Legacy Agent');
  assert.equal(projected.sourceKind, 'connected');
  assert.equal(projected.provider, 'hermes');
  assert.equal(projected.externalAgentId, 'legacy');
  assert.equal(projected.connectionStatus, 'linked');
  assert.equal(projected.workspaceId, 'ws-a');
});

test('agent defaults keep Execution Engine and Runner as separate public fields', () => {
  const agent = normalizeWorkspaceAgent({
    displayName: 'Codex Operator',
    defaultExecutionEngine: 'codex',
    defaultRunnerId: 'runner-a',
    runnerCredential: 'must-not-store',
  }, {
    id: 'agent-runner-a',
    workspaceId: 'ws-a',
  });

  assert.equal(agent.defaultExecutionEngine, 'codex');
  assert.equal(agent.defaultRunnerId, 'runner-a');
  assert.equal(JSON.stringify(agent).includes('must-not-store'), false);
  assert.equal(projectWorkspaceAgent(agent).defaultRunnerId, 'runner-a');
});
