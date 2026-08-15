'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { WorkIntake } = require('../app/lib/work-intake');
const { resolveWorkspaceScope } = require('../app/lib/workspace-scope');

function poolHarness() {
  const queries = [];
  const query = async (sql, params = []) => {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    queries.push({ sql: normalized, params });
    if (/select m\.role as role/.test(normalized)) {
      return { rowCount: 1, rows: [{ role: 'owner' }] };
    }
    if (/select id, payload from agents/.test(normalized)) {
      if (/where workspace_id = \$1 where workspace_id = \$1/.test(normalized)) {
        const error = new Error('duplicate Workspace predicate');
        error.code = 'SQL_SHAPE_INVALID';
        throw error;
      }
      return {
        rowCount: 1,
        rows: [{
          id: 'agent-research',
          payload: {
            displayName: 'Research agent',
            enabled: true,
            profileVersion: 3,
            lifecycle: { state: 'active' },
            role: 'Researcher',
            responsibility: 'Research and write cited briefs.',
            instructions: 'Separate evidence from inference.',
            specialties: ['research'],
          },
        }],
      };
    }
    return { rowCount: 0, rows: [] };
  };
  const client = { query, release() {} };
  return {
    pool: {
      query,
      async connect() { return client; },
    },
    queries,
  };
}

test('pool-backed Work Intake resolves a Responsible Agent with one Workspace predicate', async () => {
  const harness = poolHarness();
  const scope = await resolveWorkspaceScope(harness.pool, {
    workspaceId: 'ws-pool-a',
    userId: 'user-pool-a',
  });
  const intake = new WorkIntake({
    pool: harness.pool,
    contextAssembler: {
      assemble: async () => ({
        id: 'ctx-pool-a',
        digest: 'digest-pool-a',
        snapshotVersion: 1,
        citations: [{ handle: 'source:pool-a', label: 'Pool source' }],
      }),
    },
    durableExecution: {
      previewWork: async (_scope, input) => ({
        responsibleAgent: { agentId: input.agentId, profileVersion: 3 },
        effectiveConfiguration: { snapshotId: 'ecfg-pool-a', executable: true },
      }),
      acceptWork: async () => ({ ok: true }),
    },
  });

  const preview = await intake.preview(scope, {
    missionId: 'mission-pool-a',
    goal: 'Research a pool-backed Workspace source.',
  });
  const agentQuery = harness.queries.find(({ sql }) => /select id, payload from agents/.test(sql));

  assert.equal(preview.ready, true);
  assert.equal(preview.responsibleAgent.agentId, 'agent-research');
  assert.deepEqual(agentQuery?.params, ['ws-pool-a']);
  assert.equal((agentQuery?.sql.match(/where workspace_id = \$1/g) || []).length, 1);
});
