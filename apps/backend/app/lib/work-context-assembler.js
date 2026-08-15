'use strict';

const crypto = require('node:crypto');
const { assertWorkspaceScope } = require('./workspace-scope');
const { withAppRoleWorkspaceTransaction } = require('./workspace-request-context');

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function envelope(value, citations = []) {
  const digest = crypto.createHash('sha256').update(stableJson(value)).digest('hex');
  return {
    id: `wctx_${digest.slice(0, 32)}`,
    digest,
    snapshotVersion: Number(value.version || 0),
    citations,
  };
}

class WorkContextAssembler {
  constructor({ pool } = {}) {
    if (!pool) throw new Error('WorkContextAssembler requires pool');
    this.pool = pool;
  }

  async assemble(scopeValue) {
    const scope = assertWorkspaceScope(scopeValue);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const result = await client.query(
        `select id, version, claims
         from second_brain_snapshots
         where workspace_id = $1 and user_id = $2 and status = 'active'
         order by created_at desc, version desc
         limit 1`,
        [valid.workspaceId, valid.userId],
      );
      if (!result.rowCount || !Array.isArray(result.rows[0]?.claims) || !result.rows[0].claims.length) {
        return envelope({
          workspaceId: valid.workspaceId,
          userId: valid.userId,
          snapshotId: null,
          version: 0,
          claims: [],
        });
      }
      const row = result.rows[0];
      const claims = row.claims.map((claim) => {
        const id = String(claim?.id || '').trim();
        const evidenceHandle = String(claim?.provenance?.evidenceHandle || '').trim();
        return {
          id,
          text: String(claim?.text || '').trim(),
          evidenceHandle,
          citation: String(claim?.citation || '').trim(),
        };
      });
      const citations = claims
        .filter((claim) => claim.evidenceHandle && claim.citation)
        .map((claim) => ({ handle: claim.evidenceHandle, label: claim.citation }));
      return envelope({
        workspaceId: valid.workspaceId,
        userId: valid.userId,
        snapshotId: String(row.id || ''),
        version: Number(row.version || 0),
        claims,
      }, citations);
    });
  }
}

module.exports = {
  WorkContextAssembler,
};
