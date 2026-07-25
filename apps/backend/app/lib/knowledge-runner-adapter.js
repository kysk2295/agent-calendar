'use strict';

/**
 * Knowledge search Runner protocol adapters.
 *
 * Production path: real device-authenticated Runner claims durable execution offers
 * and posts leased attempt evidence. A live customer Runner may be unexercised in CI.
 *
 * Fake adapter: drives next-offer → lease → artifact (snippets only) → complete
 * for tests. Never persists raw local paths as public evidence.
 */

const crypto = require('node:crypto');

function newToken() {
  return `evh_${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * Pure policy: convert private-local "runner hits" into safe evidence snippets.
 * Rejects absolute paths and large bodies.
 */
function sanitizeRunnerHits(hits = [], { maxExcerpt = 280 } = {}) {
  const out = [];
  for (const hit of hits || []) {
    const title = String(hit.title || hit.label || 'Untitled').slice(0, 200);
    let excerpt = String(hit.excerpt || hit.snippet || '').slice(0, maxExcerpt);
    const rawPath = String(hit.path || hit.localPath || hit.filePath || '');
    // Never accept absolute/local paths as public evidence fields.
    if (/^\/|^[A-Za-z]:[\\/]|^~[/\\]/.test(rawPath) || rawPath.includes('..')) {
      // Drop path; keep opaque runner handle if present.
    }
    const runnerContentHandle = String(hit.runnerContentHandle || hit.handle || '').slice(0, 200);
    if (!excerpt && !runnerContentHandle && !title) continue;
    // Strip any residual absolute path strings from excerpt.
    excerpt = excerpt.replace(/(?:^|[\s"'])(\/(?:Users|home|var|tmp|private)\/[^\s"']+)/gi, ' [local] ');
    out.push({
      title,
      excerpt,
      runnerContentHandle: runnerContentHandle || newToken(),
      chunkIndex: Number.isFinite(Number(hit.chunkIndex)) ? Number(hit.chunkIndex) : 0,
      sourceId: hit.sourceId ? String(hit.sourceId) : '',
      documentId: hit.documentId ? String(hit.documentId) : '',
    });
  }
  return out;
}

/**
 * Fake in-process Runner that completes knowledge_search jobs using an injected
 * local index (metadata/snippets only). Used by tests and local QA — not a live host claim.
 */
function createFakeKnowledgeRunnerAdapter({
  localIndexByWorkspace = new Map(),
  deviceAuthHeaders = null,
  httpJson = null,
  baseUrl = '',
} = {}) {
  return {
    kind: 'fake',
    localIndexByWorkspace,
    /**
     * Register private-local snippets for a workspace (test fixture only).
     * Entries: { sourceId, title, excerpt, runnerContentHandle?, path? }
     * Paths are never returned as evidence.
     */
    seedLocalIndex(workspaceId, entries) {
      const list = Array.isArray(entries) ? entries : [];
      this.localIndexByWorkspace.set(String(workspaceId), list);
    },
    async processOne({
      runnerId,
      workspaceId,
      keys,
      credential,
      sessionId,
      cursor,
      capabilities = { engines: { fake: true }, localKnowledge: true, knowledgeSearch: true },
    } = {}) {
      if (typeof httpJson !== 'function' || !baseUrl) {
        return { ok: false, reason: 'http_not_configured' };
      }
      void capabilities;
      const nextBody = { runnerId };
      const next = await httpJson(baseUrl, 'POST', '/api/runner/device/next-offer', {
        body: nextBody,
        headers: deviceAuthHeaders({
          keys, runnerId, credential, method: 'POST', path: '/api/runner/device/next-offer',
          body: nextBody, sessionId, cursor,
        }),
      });
      if (!next || next.status !== 200 || !next.json?.offer) {
        return { ok: true, offer: null };
      }
      const offer = next.json.offer;
      const leaseBody = { offerId: offer.offerId, runnerId };
      const leaseRes = await httpJson(baseUrl, 'POST', '/api/runner/device/lease', {
        body: leaseBody,
        headers: deviceAuthHeaders({
          keys, runnerId, credential, method: 'POST', path: '/api/runner/device/lease',
          body: leaseBody, sessionId, cursor,
        }),
      });
      if (leaseRes.status !== 200 || !leaseRes.json?.lease) {
        return { ok: false, reason: 'lease_failed', detail: leaseRes.json };
      }
      const lease = leaseRes.json.lease;
      const goal = String(offer.goal || lease.goal || '');
      const isKnowledge = /knowledge_search|knowledge-search/i.test(goal)
        || offer.payload?.kind === 'knowledge_search'
        || offer.jobPayload?.kind === 'knowledge_search';
      if (!isKnowledge) {
        // Leave non-knowledge jobs alone.
        return { ok: true, skipped: true, offer };
      }
      const query = String(
        offer.payload?.query
        || offer.jobPayload?.query
        || goal.replace(/^knowledge_search:\s*/i, ''),
      ).toLowerCase();
      const index = this.localIndexByWorkspace.get(String(workspaceId || offer.workspaceId || '')) || [];
      const matched = index.filter((row) => {
        const hay = `${row.title || ''} ${row.excerpt || ''} ${row.path || ''}`.toLowerCase();
        return !query || hay.includes(query);
      });
      const hits = sanitizeRunnerHits(matched.map((row) => ({
        title: row.title,
        excerpt: row.excerpt || String(row.content || '').slice(0, 200),
        sourceId: row.sourceId,
        documentId: row.documentId,
        runnerContentHandle: row.runnerContentHandle,
        // Intentionally omit path even if fixture had one
      })));
      const artifactBody = {
        attemptId: lease.attemptId,
        leaseEpoch: lease.leaseEpoch,
        name: 'knowledge-search-evidence',
        contentType: 'application/json',
        content: JSON.stringify({
          kind: 'knowledge_search_evidence',
          query,
          hits,
        }),
        idempotencyKey: `knowledge-evidence:${lease.attemptId}`,
        runnerId,
      };
      await httpJson(baseUrl, 'POST', '/api/runner/device/artifact', {
        body: artifactBody,
        headers: deviceAuthHeaders({
          keys, runnerId, credential, method: 'POST', path: '/api/runner/device/artifact',
          body: artifactBody, sessionId, cursor,
        }),
      });
      const completeBody = {
        attemptId: lease.attemptId,
        leaseEpoch: lease.leaseEpoch,
        summary: JSON.stringify({
          kind: 'knowledge_search_result',
          hitCount: hits.length,
          hits,
        }),
        idempotencyKey: `knowledge-complete:${lease.attemptId}`,
        runnerId,
      };
      const done = await httpJson(baseUrl, 'POST', '/api/runner/device/complete', {
        body: completeBody,
        headers: deviceAuthHeaders({
          keys, runnerId, credential, method: 'POST', path: '/api/runner/device/complete',
          body: completeBody, sessionId, cursor,
        }),
      });
      return {
        ok: done.status === 200,
        completed: true,
        jobId: lease.jobId,
        attemptId: lease.attemptId,
        hits,
        complete: done.json,
      };
    },
  };
}

function runnerHasLocalKnowledgeCapability(capabilities = {}) {
  const caps = capabilities && typeof capabilities === 'object' ? capabilities : {};
  if (caps.localKnowledge === true || caps.knowledgeSearch === true) return true;
  if (caps.local_knowledge === true || caps.knowledge_search === true) return true;
  if (Array.isArray(caps.features) && caps.features.some((f) => /local.?knowledge|knowledge.?search/i.test(String(f)))) {
    return true;
  }
  return false;
}

module.exports = {
  sanitizeRunnerHits,
  createFakeKnowledgeRunnerAdapter,
  runnerHasLocalKnowledgeCapability,
};
