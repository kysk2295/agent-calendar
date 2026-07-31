'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  agentExecutionProfile,
  applyAgentExecutionProfile,
  normalizeRunnerCapabilityCatalog,
  normalizeWorkspaceAgent,
  projectWorkspaceAgent,
  resolveEffectiveAgentConfiguration,
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
    grants: { allow: [], deny: [] },
    lifecycle: {
      origin: 'manual',
      state: 'draft',
      revision: 1,
      reviewedRevision: 0,
      testedRevision: 0,
      activeVersion: 0,
      request: '',
      lastTest: null,
      reviewedAt: null,
      activatedAt: null,
    },
    enabled: false,
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
  const snapshot = agentExecutionProfile({
    ...agent,
    lifecycle: {
      ...agent.lifecycle,
      state: 'active',
      reviewedRevision: 1,
      testedRevision: 1,
      activeVersion: 1,
    },
    enabled: true,
  });
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

test('effective configuration is default-deny with deny-over-allow and a stable redacted identity', () => {
  const agent = normalizeWorkspaceAgent({
    displayName: 'Bounded researcher',
    grants: {
      allow: ['tool:web.read', 'tool:mail.send', 'skill:summarize'],
      deny: ['tool:mail.send'],
    },
    approvedGrants: {
      allow: ['tool:web.read', 'tool:mail.send', 'skill:summarize'],
      deny: ['tool:mail.send'],
    },
  }, {
    id: 'agent-bounded',
    workspaceId: 'ws-a',
  });
  const catalog = normalizeRunnerCapabilityCatalog({
    catalogId: 'runner-standard',
    version: 4,
    entries: [
      { id: 'tool:web.read', version: 2, kind: 'tool' },
      { id: 'tool:mail.send', version: 1, kind: 'tool', externalDelivery: true },
      { id: 'skill:summarize', version: 3, kind: 'skill' },
      { id: 'tool:filesystem.write', version: 1, kind: 'tool' },
    ],
    token: 'must-not-store',
  });

  const effective = resolveEffectiveAgentConfiguration({
    workspaceId: 'ws-a',
    agent,
    runner: {
      id: 'runner-a',
      capabilities: { catalog, token: 'must-not-store' },
    },
    requestedEngine: 'codex',
    requestedModel: 'gpt-5.6-codex',
    reason: 'explicit',
    requiredCapabilities: ['tool:web.read', 'tool:mail.send', 'tool:filesystem.write'],
  });

  assert.deepEqual(effective.grants.allowed.map((entry) => entry.id), [
    'skill:summarize',
    'tool:web.read',
  ]);
  assert.deepEqual(effective.grants.denied, [
    'tool:filesystem.write',
    'tool:mail.send',
  ]);
  assert.equal(effective.executable, false);
  assert.match(effective.runner.ref, /^runner_[a-f0-9]{16}$/);
  assert.equal(effective.runner.id, undefined);
  assert.match(effective.snapshotId, /^ecfg_[a-f0-9]{32}$/);
  assert.equal(JSON.stringify(effective).includes('runner-a'), false);
  assert.equal(JSON.stringify(effective).includes('must-not-store'), false);
});

test('profile or Runner catalog mutation invalidates a preview identity', () => {
  const agent = normalizeWorkspaceAgent({
    displayName: 'Preview agent',
    approvedGrants: { allow: ['tool:web.read'], deny: [] },
  }, { id: 'agent-preview', workspaceId: 'ws-a' });
  const runner = {
    id: 'runner-a',
    capabilities: {
      catalog: {
        catalogId: 'runner-standard',
        version: 1,
        entries: [{ id: 'tool:web.read', version: 1, kind: 'tool' }],
      },
    },
  };
  const preview = resolveEffectiveAgentConfiguration({
    workspaceId: 'ws-a',
    agent,
    runner,
    requestedEngine: 'codex',
    requiredCapabilities: ['tool:web.read'],
  });
  assert.equal(preview.executable, true);

  const revised = normalizeWorkspaceAgent({
    responseStyle: 'Concise',
  }, { id: agent.id, workspaceId: 'ws-a', existing: agent });
  assert.throws(
    () => resolveEffectiveAgentConfiguration({
      workspaceId: 'ws-a',
      agent: revised,
      runner,
      requestedEngine: 'codex',
      requiredCapabilities: ['tool:web.read'],
      expectedSnapshotId: preview.snapshotId,
    }),
    (error) => error?.code === 'effective_configuration_stale' && error?.statusHint === 409,
  );

  assert.throws(
    () => resolveEffectiveAgentConfiguration({
      workspaceId: 'ws-a',
      agent,
      runner: {
        ...runner,
        capabilities: {
          catalog: {
            ...runner.capabilities.catalog,
            version: 2,
          },
        },
      },
      requestedEngine: 'codex',
      requiredCapabilities: ['tool:web.read'],
      expectedSnapshotId: preview.snapshotId,
    }),
    (error) => error?.code === 'effective_configuration_stale',
  );
});

test('grant expansion is retained as an Approval Gate while reductions apply immediately', () => {
  const existing = normalizeWorkspaceAgent({
    displayName: 'Approval agent',
    approvedGrants: {
      allow: ['tool:web.read'],
      deny: [],
    },
  }, { id: 'agent-approval', workspaceId: 'ws-a' });

  const expansion = normalizeWorkspaceAgent({
    grants: {
      allow: ['tool:web.read', 'tool:mail.send'],
      deny: [],
    },
  }, { id: existing.id, workspaceId: 'ws-a', existing });
  assert.deepEqual(expansion.grants.allow, ['tool:web.read']);
  assert.deepEqual(expansion.approvalGate.requestedGrants.allow, [
    'tool:mail.send',
    'tool:web.read',
  ]);
  assert.equal(expansion.approvalGate.status, 'pending');
  assert.equal(expansion.approvalGate.reason, 'grant_expansion');

  const reduction = normalizeWorkspaceAgent({
    grants: {
      allow: [],
      deny: ['tool:web.read'],
    },
  }, { id: existing.id, workspaceId: 'ws-a', existing });
  assert.deepEqual(reduction.grants, {
    allow: [],
    deny: ['tool:web.read'],
  });
  assert.equal(reduction.approvalGate, undefined);
});

test('legacy direct-enabled manual agent rows remain active profile v1 projections', () => {
  const created = projectWorkspaceAgent({
    id: 'agent-manual-pin',
    displayName: 'Manual compatibility agent',
    role: 'Researcher',
    responsibility: 'Summarize a bounded topic.',
    defaultExecutionEngine: 'codex',
    workspaceId: 'ws-pin',
    enabled: true,
  });

  assert.deepEqual({
    id: created.id,
    displayName: created.displayName,
    enabled: created.enabled,
    profileVersion: created.profileVersion,
    connectionStatus: created.connectionStatus,
    grants: created.grants,
  }, {
    id: 'agent-manual-pin',
    displayName: 'Manual compatibility agent',
    enabled: true,
    profileVersion: 1,
    connectionStatus: 'ready',
    grants: { allow: [], deny: [] },
  });
});

test('effective configuration identity survives a jsonb round trip and the Runner recomputes it', () => {
  // The Runner independently recomputes ecfg_ from the delivered payload, and that payload
  // round-trips through jsonb, which does not preserve key insertion order.
  const {
    assertEffectiveConfiguration,
    runnerCapabilityCatalog,
  } = require('../../runner/lib/capability-grants');

  const localCatalog = runnerCapabilityCatalog();
  const agent = normalizeWorkspaceAgent({
    displayName: 'Runner-verified agent',
    grants: { allow: [], deny: [] },
  }, { id: 'agent-runner-verified', workspaceId: 'ws-a' });

  const effective = resolveEffectiveAgentConfiguration({
    workspaceId: 'ws-a',
    agent,
    runner: { id: 'runner-a', capabilities: { catalog: localCatalog } },
    requestedEngine: 'codex',
    resolvedEngine: 'codex',
    requestedModel: 'gpt-5.6-codex',
    reason: 'explicit',
    requiredCapabilities: [],
  });
  assert.equal(effective.executable, true);

  function scrambleKeys(value) {
    if (Array.isArray(value)) return value.map(scrambleKeys);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value).sort().reverse().map((key) => [key, scrambleKeys(value[key])]),
      );
    }
    return value;
  }

  const delivered = scrambleKeys(JSON.parse(JSON.stringify(effective)));
  assert.doesNotThrow(() => assertEffectiveConfiguration(delivered));
});
