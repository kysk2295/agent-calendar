'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { DurableExecution } = require('../app/lib/durable-execution');
const { resolveWorkspaceScope } = require('../app/lib/workspace-scope');

test('client-injected Work Intake payload cannot bypass preview attestation', async () => {
  const scope = await resolveWorkspaceScope({
    query: async () => ({ rowCount: 1, rows: [{ role: 'owner' }] }),
  }, {
    workspaceId: 'ws-attestation',
    userId: 'user-attestation',
    role: 'owner',
  });
  const durable = new DurableExecution({ pool: {}, env: { NODE_ENV: 'test' } });

  await assert.rejects(
    durable.acceptWork(scope, {
      missionId: 'mission-injected-intake',
      goal: 'Bypass the reviewed Work preview.',
      agentId: 'agent-research',
      payload: {
        workIntake: {
          previewSnapshotId: 'wip_injected',
          responsibleAgentId: 'agent-research',
          responsibleAgentProfileVersion: 3,
        },
      },
    }),
    (error) => error.code === 'WORK_PREVIEW_ATTESTATION_REQUIRED' && error.statusHint === 409,
  );
});
