'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { WorkContextAssembler } = require('../app/lib/work-context-assembler');
const { resolveWorkspaceScope } = require('../app/lib/workspace-scope');

function snapshotPool(rows = []) {
  const queries = [];
  const query = async (sql, params = []) => {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    queries.push({ sql: normalized, params });
    if (/select m\.role as role/.test(normalized)) {
      return { rowCount: 1, rows: [{ role: 'owner' }] };
    }
    if (/from second_brain_snapshots/.test(normalized)) {
      const matching = rows
        .filter((row) => row.workspace_id === params[0]
          && row.user_id === params[1]
          && row.status === 'active')
        .sort((left, right) => Number(right.version) - Number(left.version));
      return { rowCount: matching.length ? 1 : 0, rows: matching.slice(0, 1) };
    }
    return { rowCount: 0, rows: [] };
  };
  const client = { query, release() {} };
  return {
    queries,
    pool: {
      query,
      async connect() { return client; },
    },
  };
}

test('source-empty assemble has empty citations and does not fabricate claims', async () => {
  const fixture = snapshotPool();
  const scope = await resolveWorkspaceScope(fixture.pool, {
    workspaceId: 'workspace-a',
    userId: 'user-a',
  });
  const assembler = new WorkContextAssembler({ pool: fixture.pool });

  const first = await assembler.assemble(scope, { purpose: 'work', query: 'prepare a brief' });
  const repeated = await assembler.assemble(scope, { purpose: 'work', query: 'different wording' });

  assert.deepEqual(first.citations, []);
  assert.equal(first.snapshotVersion, 0);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  assert.match(first.id, /^wctx_[a-f0-9]{32}$/);
  assert.notEqual(first.digest, 'digest-1');
  assert.deepEqual(repeated, first);
  const snapshotQueries = fixture.queries.filter(({ sql }) => /from second_brain_snapshots/.test(sql));
  assert.equal(snapshotQueries.length, 2);
  assert.deepEqual(snapshotQueries[0].params, ['workspace-a', 'user-a']);
  assert.match(snapshotQueries[0].sql, /workspace_id\s*=\s*\$1/);
  assert.match(snapshotQueries[0].sql, /user_id\s*=\s*\$2/);
  assert.equal(fixture.queries.some(({ sql }) => /context_envelopes/.test(sql)), false);
});

test('assemble digest snapshotVersion and citations follow the caller active second_brain snapshot', async () => {
  const fixture = snapshotPool([{
    id: 'snapshot-a-v2',
    workspace_id: 'workspace-a',
    user_id: 'user-a',
    status: 'active',
    version: 2,
    created_at: '2026-08-16T01:00:00.000Z',
    claims: [
      {
        id: 'claim-grounded',
        text: 'Review the quarterly objective before Friday.',
        citation: '메일 · 분기 목표',
        provenance: { evidenceHandle: 'mail:message-1' },
      },
      {
        id: 'claim-without-citation',
        text: 'This must not become a visible citation.',
        provenance: { evidenceHandle: 'mail:message-2' },
      },
    ],
  }]);
  const scope = await resolveWorkspaceScope(fixture.pool, {
    workspaceId: 'workspace-a',
    userId: 'user-a',
  });

  const assembled = await new WorkContextAssembler({ pool: fixture.pool }).assemble(scope, {
    purpose: 'work',
  });

  assert.equal(assembled.snapshotVersion, 2);
  assert.deepEqual(assembled.citations, [{
    handle: 'mail:message-1',
    label: '메일 · 분기 목표',
  }]);
  assert.match(assembled.id, /^wctx_[a-f0-9]{32}$/);
  assert.equal(Object.hasOwn(assembled, 'claims'), false);
});

test('assemble does not substitute a claim id for missing provenance evidence', async () => {
  const fixture = snapshotPool([{
    id: 'snapshot-no-provenance',
    workspace_id: 'workspace-a',
    user_id: 'user-a',
    status: 'active',
    version: 1,
    claims: [{
      id: 'claim-is-not-evidence',
      text: 'A label alone is not grounded evidence.',
      citation: '메일 · 근거 없는 라벨',
    }],
  }]);
  const scope = await resolveWorkspaceScope(fixture.pool, {
    workspaceId: 'workspace-a',
    userId: 'user-a',
  });

  const assembled = await new WorkContextAssembler({ pool: fixture.pool }).assemble(scope, {
    purpose: 'work',
  });

  assert.deepEqual(assembled.citations, []);
});

test('assemble digest and snapshotVersion change when the active snapshot changes', async () => {
  const rows = [{
    id: 'snapshot-a-v2',
    workspace_id: 'workspace-a',
    user_id: 'user-a',
    status: 'active',
    version: 2,
    claims: [{
      id: 'claim-a',
      text: 'Version two fact.',
      citation: '파일 · v2',
      provenance: { evidenceHandle: 'file:v2' },
    }],
  }];
  const fixture = snapshotPool(rows);
  const scope = await resolveWorkspaceScope(fixture.pool, {
    workspaceId: 'workspace-a',
    userId: 'user-a',
  });
  const assembler = new WorkContextAssembler({ pool: fixture.pool });
  const versionTwo = await assembler.assemble(scope, { purpose: 'work' });

  rows.push({
    id: 'snapshot-a-v3',
    workspace_id: 'workspace-a',
    user_id: 'user-a',
    status: 'active',
    version: 3,
    claims: [{
      id: 'claim-a',
      text: 'Version three corrected fact.',
      citation: '파일 · v3',
      provenance: { evidenceHandle: 'file:v3' },
    }],
  });
  const versionThree = await assembler.assemble(scope, { purpose: 'work' });

  assert.equal(versionTwo.snapshotVersion, 2);
  assert.equal(versionThree.snapshotVersion, 3);
  assert.notEqual(versionThree.digest, versionTwo.digest);
  assert.notEqual(versionThree.id, versionTwo.id);
  assert.deepEqual(versionThree.citations, [{ handle: 'file:v3', label: '파일 · v3' }]);
});

test('assemble does not read another user or workspace active snapshot', async () => {
  const fixture = snapshotPool([
    {
      id: 'snapshot-a', workspace_id: 'workspace-a', user_id: 'user-a', status: 'active', version: 1,
      claims: [{
        id: 'claim-a',
        text: 'Caller fact',
        citation: 'A citation',
        provenance: { evidenceHandle: 'calendar:event-a' },
      }],
    },
    {
      id: 'snapshot-other-user', workspace_id: 'workspace-a', user_id: 'user-b', status: 'active', version: 99,
      claims: [{ id: 'claim-b', text: 'Other user fact', citation: 'B citation' }],
    },
    {
      id: 'snapshot-other-workspace', workspace_id: 'workspace-b', user_id: 'user-a', status: 'active', version: 100,
      claims: [{ id: 'claim-c', text: 'Other workspace fact', citation: 'C citation' }],
    },
  ]);
  const scope = await resolveWorkspaceScope(fixture.pool, {
    workspaceId: 'workspace-a',
    userId: 'user-a',
  });

  const assembled = await new WorkContextAssembler({ pool: fixture.pool }).assemble(scope, {
    purpose: 'work',
  });

  assert.equal(assembled.snapshotVersion, 1);
  assert.deepEqual(assembled.citations, [{ handle: 'calendar:event-a', label: 'A citation' }]);
  const snapshotQueries = fixture.queries.filter(({ sql }) => /from second_brain_snapshots/.test(sql));
  assert.equal(snapshotQueries.length, 1);
  assert.deepEqual(snapshotQueries[0].params, ['workspace-a', 'user-a']);
});
