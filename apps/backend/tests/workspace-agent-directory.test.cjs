'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  agentExecutionProfile,
  applyAgentExecutionProfile,
  normalizeWorkspaceAgent,
  projectWorkspaceAgent,
} = require('../app/lib/workspace-agent-directory');

test('native Workspace agents keep responsibility fields and never persist credentials', () => {
  const agent = normalizeWorkspaceAgent({
    displayName: '리서치 파트너',
    role: '시장 리서처',
    responsibility: '매주 경쟁사 변화를 조사한다.',
    instructions: '사실과 추정을 구분한다.',
    responseStyle: '차분하고 간결하게, 반대 근거를 먼저 말한다.',
    specialties: ['시장 조사', '출처 검증'],
    memories: ['사용자는 한국어 보고서를 선호한다.', '결론에는 근거 링크가 필요하다.'],
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
    responseStyle: '차분하고 간결하게, 반대 근거를 먼저 말한다.',
    specialties: ['시장 조사', '출처 검증'],
    memories: ['사용자는 한국어 보고서를 선호한다.', '결론에는 근거 링크가 필요하다.'],
    profileVersion: 1,
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

test('profile updates bump the version only when execution-relevant identity changes', () => {
  const created = normalizeWorkspaceAgent({
    displayName: 'Editor',
    role: '문서 편집자',
    responseStyle: '따뜻하고 단정하게 말한다.',
    memories: [
      '  사용자는 요약을 먼저 본다.  ',
      '사용자는 요약을 먼저 본다.',
      '',
      '표에는 출처 열을 포함한다.',
    ],
  }, {
    id: 'agent-editor',
    workspaceId: 'ws-a',
  });
  assert.equal(created.profileVersion, 1);
  assert.deepEqual(created.memories, [
    '사용자는 요약을 먼저 본다.',
    '표에는 출처 열을 포함한다.',
  ]);

  const unchanged = normalizeWorkspaceAgent({
    displayName: 'Editor',
  }, {
    id: 'agent-editor',
    workspaceId: 'ws-a',
    existing: created,
  });
  assert.equal(unchanged.profileVersion, 1);

  const revised = normalizeWorkspaceAgent({
    responseStyle: '직설적이고 근거 중심으로 말한다.',
  }, {
    id: 'agent-editor',
    workspaceId: 'ws-a',
    existing: unchanged,
  });
  assert.equal(revised.profileVersion, 2);
  assert.equal(projectWorkspaceAgent(revised).profileVersion, 2);
});

test('execution profile is a bounded immutable snapshot applied ahead of the delegated goal', () => {
  const agent = normalizeWorkspaceAgent({
    displayName: 'Research Partner',
    role: '시장 리서처',
    responsibility: '의사결정 가능한 경쟁사 분석을 만든다.',
    instructions: '사실과 추정을 분리하고 출처를 확인한다.',
    responseStyle: '차분한 존댓말로 핵심부터 쓴다.',
    specialties: ['시장 조사', '출처 검증'],
    memories: ['사용자는 한국어를 선호한다.', 'USD와 KRW를 함께 표시한다.'],
    apiKey: 'must-not-store',
  }, {
    id: 'agent-research',
    workspaceId: 'ws-a',
  });
  const snapshot = agentExecutionProfile(agent);
  assert.deepEqual(snapshot, {
    agentId: 'agent-research',
    displayName: 'Research Partner',
    role: '시장 리서처',
    responsibility: '의사결정 가능한 경쟁사 분석을 만든다.',
    instructions: '사실과 추정을 분리하고 출처를 확인한다.',
    responseStyle: '차분한 존댓말로 핵심부터 쓴다.',
    specialties: ['시장 조사', '출처 검증'],
    memories: ['사용자는 한국어를 선호한다.', 'USD와 KRW를 함께 표시한다.'],
    profileVersion: 1,
    memoryScope: 'agent_profile',
  });

  const effectiveGoal = applyAgentExecutionProfile('경쟁사 세 곳을 비교해줘.', snapshot);
  assert.match(effectiveGoal, /Responsible Agent Profile/);
  assert.match(effectiveGoal, /Profile version: 1/);
  assert.match(effectiveGoal, /차분한 존댓말/);
  assert.match(effectiveGoal, /사용자는 한국어를 선호한다/);
  assert.match(effectiveGoal, /Delegated work:\n경쟁사 세 곳을 비교해줘\./);
  assert.equal(effectiveGoal.includes('must-not-store'), false);
});
