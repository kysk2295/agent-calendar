'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { WorkIntake } = require('../app/lib/work-intake');
const { WorkspaceScopedProductService } = require('../app/lib/workspace-scoped-product-service');
const { resolveWorkspaceScope } = require('../app/lib/workspace-scope');

const SCOPE_VALUE = Object.freeze({
  workspaceId: 'ws-a',
  userId: 'user-a',
  role: 'owner',
});
const TEST_SCOPE = resolveWorkspaceScope({
  query: async () => ({ rowCount: 1, rows: [{ role: 'owner' }] }),
}, SCOPE_VALUE);

function activeAgent(profileVersion = 3) {
  return {
    agentId: 'agent-research',
    assignmentReason: 'automatic:profile_match',
    profileSnapshot: {
      agentId: 'agent-research',
      displayName: 'Research agent',
      role: 'Researcher',
      responsibility: 'Research and write cited briefs.',
      instructions: 'Separate evidence from inference.',
      responseStyle: 'Concise',
      specialties: ['research'],
      memories: [],
      profileVersion,
      memoryScope: 'agent_profile',
    },
  };
}

function createHarness() {
  let sourceRevision = 1;
  const accepted = [];
  const contextAssembler = {
    async assemble(scope, request) {
      assert.equal(scope.workspaceId, SCOPE_VALUE.workspaceId);
      assert.equal(request.purpose, 'work');
      return {
        id: `ctx-${sourceRevision}`,
        digest: `digest-${sourceRevision}`,
        snapshotVersion: sourceRevision,
        citations: [{ handle: `source:${sourceRevision}`, label: `Source ${sourceRevision}` }],
      };
    },
  };
  const durableExecution = {
    async previewWork(scope, input) {
      assert.equal(scope.workspaceId, SCOPE_VALUE.workspaceId);
      assert.equal(input.agentId, 'agent-research');
      return {
        responsibleAgent: activeAgent().profileSnapshot,
        assignmentReason: 'automatic:profile_match',
        effectiveConfiguration: {
          snapshotId: `ecfg-${sourceRevision}`,
          executable: true,
        },
      };
    },
    async acceptWork(scope, input) {
      const stored = structuredClone(input);
      accepted.push(stored);
      return {
        ok: true,
        missionId: input.missionId,
        sessionId: `session-${accepted.length}`,
        jobId: `job-${accepted.length}`,
        status: 'accepted',
        workspaceId: scope.workspaceId,
      };
    },
  };
  const intake = new WorkIntake({
    contextAssembler,
    durableExecution,
    resolveResponsibleAgent: async () => activeAgent(),
    clock: () => Date.parse('2026-08-02T00:00:00.000Z'),
  });
  return {
    intake,
    accepted,
    setSourceRevision(value) { sourceRevision = value; },
  };
}

test('Calendar AI draft preview rejects a stale context/configuration snapshot before creating Work', async () => {
  const scope = await TEST_SCOPE;
  const harness = createHarness();
  const input = {
    missionId: 'mission-calendar-ai-a',
    title: 'Prepare project brief',
    goal: 'Prepare a cited project brief from this conversation.',
    origin: {
      kind: 'calendar_ai',
      conversationId: 'conversation-a',
      turnId: 'turn-a',
      actionDraftId: 'draft-a',
    },
    workingContext: { kind: 'workspace_general' },
  };

  const preview = await harness.intake.preview(scope, input);
  assert.equal(preview.ready, true);
  assert.match(preview.snapshotId, /^wip_[a-f0-9]{32}$/);
  assert.equal(preview.contextEnvelope.id, 'ctx-1');
  assert.equal(preview.effectiveConfiguration.snapshotId, 'ecfg-1');

  harness.setSourceRevision(2);
  await assert.rejects(
    harness.intake.start(scope, { ...input, previewSnapshotId: preview.snapshotId }),
    (error) => error.code === 'WORK_PREVIEW_STALE' && error.statusHint === 409,
  );
  assert.equal(harness.accepted.length, 0);
});

test('a just-created preview remains valid across the Context Envelope default time window', async () => {
  const scope = await TEST_SCOPE;
  let now = Date.parse('2026-08-02T00:00:00.000Z');
  const assembledRanges = [];
  const accepted = [];
  const intake = new WorkIntake({
    contextAssembler: {
      async assemble(_scope, request) {
        const range = {
          from: request.range?.from || new Date(now - (30 * 86400000)).toISOString(),
          to: request.range?.to || new Date(now + (90 * 86400000)).toISOString(),
        };
        assembledRanges.push(range);
        const receipt = `${range.from}:${range.to}`;
        return {
          id: `ctx-${receipt}`,
          digest: `digest-${receipt}`,
          snapshotVersion: 7,
          citations: [{ handle: 'source:stable', label: 'Stable source' }],
        };
      },
    },
    durableExecution: {
      async previewWork() {
        return {
          responsibleAgent: activeAgent().profileSnapshot,
          assignmentReason: 'automatic:profile_match',
          effectiveConfiguration: {
            snapshotId: 'ecfg-stable',
            executable: true,
          },
        };
      },
      async acceptWork(_scope, input) {
        accepted.push(structuredClone(input));
        return {
          ok: true,
          missionId: input.missionId,
          sessionId: 'session-receipt-stable',
          jobId: 'job-receipt-stable',
          status: 'accepted',
        };
      },
    },
    resolveResponsibleAgent: async () => activeAgent(),
    clock: () => now,
  });
  const input = {
    missionId: 'mission-receipt-stable',
    goal: 'Start the unchanged attested preview.',
    origin: {
      kind: 'calendar_ai',
      conversationId: 'conversation-receipt-stable',
      turnId: 'turn-receipt-stable',
      actionDraftId: 'draft-receipt-stable',
    },
    workingContext: { kind: 'workspace_general' },
  };

  const preview = await intake.preview(scope, input);
  now += 1_000;
  const started = await intake.start(scope, {
    ...input,
    previewSnapshotId: preview.snapshotId,
  });

  assert.equal(started.missionId, input.missionId);
  assert.equal(accepted.length, 1);
  assert.deepEqual(assembledRanges[1], assembledRanges[0]);
  assert.equal(
    accepted[0].payload.workIntake.contextEnvelopeDigest,
    preview.contextEnvelope.digest,
  );
  assert.equal(accepted[0].payload.workIntake.contextEnvelopeId, preview.contextEnvelope.id);
});

test('an expired Work Intake preview is rejected even when context and assignment are unchanged', async () => {
  const scope = await TEST_SCOPE;
  let now = Date.parse('2026-08-02T00:00:00.000Z');
  const accepted = [];
  const intake = new WorkIntake({
    contextAssembler: {
      assemble: async () => ({
        id: 'ctx-static',
        digest: 'digest-static',
        snapshotVersion: 7,
        citations: [{ handle: 'source:stable', label: 'Stable source' }],
      }),
    },
    durableExecution: {
      previewWork: async () => ({
        responsibleAgent: activeAgent().profileSnapshot,
        assignmentReason: 'automatic:profile_match',
        effectiveConfiguration: {
          snapshotId: 'ecfg-static',
          executable: true,
        },
      }),
      acceptWork: async (_scope, input) => accepted.push(input),
    },
    resolveResponsibleAgent: async () => activeAgent(),
    clock: () => now,
  });
  const input = {
    missionId: 'mission-expired-preview',
    goal: 'Start only while the preview attestation is current.',
    workingContext: { kind: 'workspace_general' },
  };

  const preview = await intake.preview(scope, input);
  now += (15 * 60 * 1_000) + 1_000;

  await assert.rejects(
    intake.start(scope, { ...input, previewSnapshotId: preview.snapshotId }),
    (error) => error.code === 'WORK_PREVIEW_STALE' && error.statusHint === 409,
  );
  assert.equal(accepted.length, 0);
});

test('start preserves Calendar AI origin, envelope, fixed working context, and Responsible Agent profile', async () => {
  const scope = await TEST_SCOPE;
  const harness = createHarness();
  const input = {
    missionId: 'mission-calendar-ai-b',
    title: 'Research launch risks',
    goal: 'Research launch risks.',
    origin: {
      kind: 'calendar_ai',
      conversationId: 'conversation-b',
      turnId: 'turn-b',
      actionDraftId: 'draft-b',
    },
    workingContext: { kind: 'workspace_general' },
  };
  const preview = await harness.intake.preview(scope, input);
  const started = await harness.intake.start(scope, {
    ...input,
    previewSnapshotId: preview.snapshotId,
  });

  assert.equal(started.missionId, input.missionId);
  assert.equal(started.preview.snapshotId, preview.snapshotId);
  assert.equal(harness.accepted.length, 1);
  const accepted = harness.accepted[0];
  assert.equal(accepted.agentId, 'agent-research');
  assert.equal(accepted.effectiveConfigurationSnapshotId, 'ecfg-1');
  assert.deepEqual(accepted.payload.workIntake.origin, input.origin);
  assert.deepEqual(accepted.payload.workIntake.workingContext, { kind: 'workspace_general' });
  assert.equal(accepted.payload.workIntake.contextEnvelopeId, 'ctx-1');
  assert.equal(accepted.payload.workIntake.contextEnvelopeDigest, 'digest-1');
  assert.equal(accepted.payload.workIntake.snapshotVersion, 1);
  assert.equal(accepted.payload.workIntake.assignmentReason, 'automatic:profile_match');
  assert.equal(accepted.payload.profileSnapshot.profileVersion, 3);
  assert.deepEqual(accepted.deliverable, { kind: 'report', format: 'markdown' });
});

test('default fallback is an honest unassigned preview and cannot start as a successful assignment', async () => {
  const scope = await TEST_SCOPE;
  const accepted = [];
  const intake = new WorkIntake({
    contextAssembler: {
      assemble: async () => ({ id: 'ctx-empty', digest: 'empty', snapshotVersion: 0, citations: [] }),
    },
    durableExecution: {
      previewWork: async () => {
        throw new Error('durable preview must not run without an assignment');
      },
      acceptWork: async (_scope, input) => accepted.push(input),
    },
    resolveResponsibleAgent: async () => ({
      agentId: 'default',
      assignmentReason: 'unassigned:no_active_profile',
      profileSnapshot: null,
    }),
  });
  const input = {
    missionId: 'mission-unassigned',
    goal: 'Do useful work',
    origin: { kind: 'desktop' },
  };

  const preview = await intake.preview(scope, input);
  assert.equal(preview.ready, false);
  assert.equal(preview.assignment.status, 'unassigned');
  assert.equal(preview.assignment.reason, 'unassigned:no_active_profile');
  assert.equal(preview.responsibleAgent, null);
  await assert.rejects(
    intake.start(scope, { ...input, previewSnapshotId: preview.snapshotId }),
    (error) => error.code === 'RESPONSIBLE_AGENT_REQUIRED' && error.statusHint === 409,
  );
  assert.equal(accepted.length, 0);
});

test('local_folder keeps only an opaque handle and rejects raw local paths', async () => {
  const scope = await TEST_SCOPE;
  const harness = createHarness();
  const preview = await harness.intake.preview(scope, {
    missionId: 'mission-local',
    goal: 'Update the selected project.',
    agentId: 'agent-research',
    workingContext: {
      kind: 'local_folder',
      handle: 'folder_abcdEFGH1234',
      label: 'Selected project',
    },
  });
  assert.deepEqual(preview.workingContext, {
    kind: 'local_folder',
    handle: 'folder_abcdEFGH1234',
    label: 'Selected project',
  });
  assert.equal(JSON.stringify(preview).includes('/Users/'), false);

  await assert.rejects(
    harness.intake.preview(scope, {
      missionId: 'mission-local-path',
      goal: 'Update a private path.',
      agentId: 'agent-research',
      workingContext: {
        kind: 'local_folder',
        handle: 'folder_abcdEFGH1234',
        path: '/Users/operator/private-project',
      },
    }),
    (error) => error.code === 'WORKING_CONTEXT_RAW_PATH_FORBIDDEN',
  );
});

test('two Work starts preserve isolated origin, envelope, and execution payload state', async () => {
  const scope = await TEST_SCOPE;
  const harness = createHarness();
  const create = async (suffix) => {
    const input = {
      missionId: `mission-${suffix}`,
      goal: `Work ${suffix}`,
      origin: {
        kind: 'calendar_ai',
        conversationId: `conversation-${suffix}`,
        turnId: `turn-${suffix}`,
        actionDraftId: `draft-${suffix}`,
      },
      workingContext: { kind: 'workspace_general' },
    };
    const preview = await harness.intake.preview(scope, input);
    return harness.intake.start(scope, { ...input, previewSnapshotId: preview.snapshotId });
  };

  await create('one');
  harness.setSourceRevision(2);
  await create('two');
  harness.accepted[0].payload.workIntake.runtimeState = { error: 'first-only' };

  assert.equal(harness.accepted[0].missionId, 'mission-one');
  assert.equal(harness.accepted[1].missionId, 'mission-two');
  assert.equal(harness.accepted[0].payload.workIntake.contextEnvelopeId, 'ctx-1');
  assert.equal(harness.accepted[1].payload.workIntake.contextEnvelopeId, 'ctx-2');
  assert.equal(harness.accepted[1].payload.workIntake.runtimeState, undefined);
});

test('Workspace product service exposes narrow Work Intake preview/start entries', async () => {
  const scope = await TEST_SCOPE;
  const calls = [];
  const service = new WorkspaceScopedProductService({
    pool: {},
    workIntake: {
      preview: async (scope, input) => (calls.push(['preview', scope, input]), { snapshotId: 'wip-a' }),
      start: async (scope, input) => (calls.push(['start', scope, input]), { missionId: 'mission-a' }),
    },
  });

  assert.deepEqual(await service.previewAgentWork(scope, { goal: 'Preview' }), { snapshotId: 'wip-a' });
  assert.deepEqual(await service.startAgentWork(scope, { previewSnapshotId: 'wip-a' }), { missionId: 'mission-a' });
  assert.deepEqual(calls.map(([kind]) => kind), ['preview', 'start']);
});
