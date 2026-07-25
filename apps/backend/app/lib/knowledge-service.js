'use strict';

/**
 * Phase 5 Knowledge v2 service.
 * Workspace-scoped collections/sources/versions/chunks/ingestion/evidence/cache.
 * Private-local search uses DurableExecution + same-Workspace Runner protocol.
 */

const crypto = require('node:crypto');
const { assertWorkspaceScope } = require('./workspace-scope');
const {
  withAppRoleWorkspaceTransaction,
  withWorkspaceTransaction,
} = require('./workspace-request-context');
const {
  requireKnowledgeKey,
  resolveKnowledgeKeyBytes,
  sealKnowledge,
  openKnowledge,
  hashContent,
  hashKnowledgeTokens,
  hashEmbedding256,
  vectorLiteral,
} = require('./knowledge-crypto');
const {
  sanitizeRunnerHits,
  runnerHasLocalKnowledgeCapability,
} = require('./knowledge-runner-adapter');

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString('hex')}`;
}

function reject(code, message, statusHint = 400) {
  const err = new Error(message || code);
  err.code = code;
  err.statusHint = statusHint;
  throw err;
}

function knowledgeV2Enabled(env = process.env) {
  // Default ON when env unset; explicit 0/false/off disables (legacy wiki path).
  return !/^(0|false|off|no)$/i.test(String(env.KNOWLEDGE_V2_ENABLED ?? '1'));
}

function looksLikeAbsolutePath(value) {
  const s = String(value || '');
  return /^\/|^[A-Za-z]:[\\/]|^~[/\\]/.test(s) || s.includes('..');
}

function cacheKeyFor(question) {
  return crypto.createHash('sha256').update(String(question || '').trim().toLowerCase()).digest('hex');
}

class KnowledgeService {
  /**
   * @param {object} opts
   * @param {import('pg').Pool} opts.pool
   * @param {object} [opts.env]
   * @param {import('./durable-execution').DurableExecution} [opts.durableExecution]
   * @param {object} [opts.legacyProduct] WorkspaceScopedProductService for rollback
   * @param {function} [opts.clock]
   */
  constructor({
    pool,
    env = process.env,
    durableExecution = null,
    legacyProduct = null,
    inferenceBroker = null,
    clock = () => Date.now(),
  } = {}) {
    this.pool = pool;
    this.env = env;
    this.durableExecution = durableExecution;
    this.legacyProduct = legacyProduct;
    this.inferenceBroker = inferenceBroker;
    this.clock = clock;
  }

  enabled() {
    return knowledgeV2Enabled(this.env);
  }

  async #audit(client, {
    workspaceId, actorUserId = '', action, entityKind = '', entityId = '', detail = {},
  }) {
    await client.query(
      `insert into knowledge_audit_events (
         id, workspace_id, actor_user_id, action, entity_kind, entity_id, detail
       ) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        newId('kaud'),
        workspaceId,
        actorUserId,
        action,
        entityKind,
        entityId,
        JSON.stringify(detail || {}),
      ],
    );
  }

  async ensureDefaultCollection(scope) {
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const existing = await client.query(
        `select * from knowledge_collections
         where workspace_id = $1 and name = 'default' limit 1`,
        [valid.workspaceId],
      );
      if (existing.rowCount) return this.#publicCollection(existing.rows[0]);
      const id = newId('kcol');
      await client.query(
        `insert into knowledge_collections (
           id, workspace_id, name, description, status, created_by_user_id
         ) values ($1,$2,'default','Default knowledge collection','active',$3)`,
        [id, valid.workspaceId, valid.userId],
      );
      return {
        id, workspaceId: valid.workspaceId, name: 'default', status: 'active',
      };
    });
  }

  async listCollections(scope) {
    if (!this.enabled() && this.legacyProduct) {
      return { ok: true, mode: 'legacy', collections: [] };
    }
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const rows = await client.query(
        `select * from knowledge_collections where workspace_id = $1 order by name asc`,
        [valid.workspaceId],
      );
      return { ok: true, collections: rows.rows.map((r) => this.#publicCollection(r)) };
    });
  }

  async registerSource(scope, {
    sourceKind = 'cloud_indexed',
    label = '',
    path = '',
    collectionId = null,
    cloudOptIn = false,
  } = {}) {
    if (!this.enabled()) reject('KNOWLEDGE_V2_DISABLED', 'Knowledge v2 disabled', 403);
    const kind = String(sourceKind || '').toLowerCase();
    if (!['cloud_indexed', 'private_local', 'legacy_wiki'].includes(kind)) {
      reject('SOURCE_KIND_INVALID', 'sourceKind must be cloud_indexed|private_local|legacy_wiki', 400);
    }
    if (looksLikeAbsolutePath(path) && kind === 'private_local') {
      // Allow logical relative names only for registration metadata — store basename only.
    }
    const logicalPath = String(path || label || newId('doc')).replace(/^.*[/\\]/, '').slice(0, 500)
      || newId('doc');

    if (kind === 'cloud_indexed') {
      if (!cloudOptIn) {
        reject('CLOUD_OPT_IN_REQUIRED', 'cloud_indexed sources require explicit cloudOptIn=true', 400);
      }
      requireKnowledgeKey(this.env);
    }

    const collection = collectionId
      ? { id: collectionId }
      : await this.ensureDefaultCollection(scope);

    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const id = newId('ksrc');
      await client.query(
        `insert into knowledge_sources (
           id, workspace_id, collection_id, source_kind, label, path, status,
           cloud_opt_in, encryption_required, runner_required, created_by_user_id, provenance
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [
          id,
          valid.workspaceId,
          collection.id,
          kind,
          String(label || logicalPath).slice(0, 300),
          logicalPath,
          kind === 'private_local' ? 'ready' : 'active',
          kind === 'cloud_indexed' && Boolean(cloudOptIn),
          kind === 'cloud_indexed',
          kind === 'private_local',
          valid.userId,
          JSON.stringify({ registeredAt: new Date(this.clock()).toISOString(), sourceKind: kind }),
        ],
      );
      await this.#audit(client, {
        workspaceId: valid.workspaceId,
        actorUserId: valid.userId,
        action: 'source.register',
        entityKind: 'knowledge_source',
        entityId: id,
        detail: { sourceKind: kind, path: logicalPath, cloudOptIn: Boolean(cloudOptIn) },
      });
      const row = await client.query(
        `select * from knowledge_sources where workspace_id = $1 and id = $2`,
        [valid.workspaceId, id],
      );
      return { ok: true, source: this.#publicSource(row.rows[0]) };
    });
  }

  async listSources(scope) {
    if (!this.enabled()) return { ok: true, mode: 'legacy', sources: [] };
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const rows = await client.query(
        `select * from knowledge_sources
         where workspace_id = $1
         order by created_at desc`,
        [valid.workspaceId],
      );
      return { ok: true, sources: rows.rows.map((r) => this.#publicSource(r)) };
    });
  }

  /**
   * Ingest cloud-indexed content (encrypted at rest). Never used for private_local full content.
   */
  async ingestCloudDocument(scope, {
    sourceId,
    title = '',
    path = '',
    content = '',
  } = {}) {
    if (!this.enabled()) reject('KNOWLEDGE_V2_DISABLED', 'Knowledge v2 disabled', 403);
    const keyBytes = requireKnowledgeKey(this.env);
    const body = String(content || '');
    if (!body) reject('CONTENT_REQUIRED', 'content required for cloud ingest', 400);
    if (looksLikeAbsolutePath(path)) {
      // Normalize to basename for storage metadata
    }
    const logicalPath = String(path || title || 'document.md').replace(/^.*[/\\]/, '').slice(0, 500);

    return withWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const src = await client.query(
        `select * from knowledge_sources where workspace_id = $1 and id = $2 for update`,
        [valid.workspaceId, String(sourceId || '')],
      );
      if (!src.rowCount) reject('SOURCE_NOT_FOUND', 'source not found', 404);
      const source = src.rows[0];
      if (source.status === 'revoked') reject('SOURCE_REVOKED', 'source revoked', 410);
      if (source.source_kind !== 'cloud_indexed') {
        reject('SOURCE_KIND_MISMATCH', 'ingestCloudDocument only for cloud_indexed sources', 400);
      }
      if (!source.cloud_opt_in) {
        reject('CLOUD_OPT_IN_REQUIRED', 'cloud opt-in required', 400);
      }

      const docId = newId('kdoc');
      const versionId = newId('kver');
      const jobId = newId('king');
      const sha = hashContent(body);
      const ciphertext = sealKnowledge(body, keyBytes);
      const blobId = newId('kblob');

      await client.query(
        `insert into knowledge_documents (
           id, workspace_id, source_id, collection_id, title, path, status, current_version_id, metadata
         ) values ($1,$2,$3,$4,$5,$6,'active',$7,$8::jsonb)`,
        [
          docId, valid.workspaceId, source.id, source.collection_id,
          String(title || logicalPath).slice(0, 300), logicalPath, versionId,
          JSON.stringify({ storageMode: 'server_encrypted' }),
        ],
      );
      await client.query(
        `insert into knowledge_versions (
           id, workspace_id, document_id, source_id, version_number, content_sha256,
           storage_mode, blob_ref, byte_length, created_by_user_id
         ) values ($1,$2,$3,$4,1,$5,'server_encrypted',$6,$7,$8)`,
        [versionId, valid.workspaceId, docId, source.id, sha, blobId, body.length, valid.userId],
      );
      await client.query(
        `insert into knowledge_object_blobs (
           id, workspace_id, source_id, version_id, ciphertext, content_sha256
         ) values ($1,$2,$3,$4,$5,$6)`,
        [blobId, valid.workspaceId, source.id, versionId, ciphertext, sha],
      );

      const chunks = this.#chunkText(body, String(title || logicalPath));
      for (let i = 0; i < chunks.length; i += 1) {
        const ch = chunks[i];
        const emb = hashEmbedding256(ch.content);
        const keywordHashes = hashKnowledgeTokens(
          `${ch.title} ${logicalPath} ${ch.content}`,
          keyBytes,
        );
        const chunkId = newId('kchk');
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `insert into knowledge_chunks (
             id, workspace_id, source_id, document_id, version_id, chunk_index,
             title, path, content, excerpt, content_enc, excerpt_enc, keyword_hashes,
             embedding, embedding_vector, embedding_model, status
           ) values (
             $1,$2,$3,$4,$5,$6,$7,$8,'','',$9,$10,$11::text[],
             $12::jsonb,$13::vector,'hermes-hash-embedding-v1','active'
           )`,
          [
            chunkId, valid.workspaceId, source.id, docId, versionId, i,
            ch.title, logicalPath,
            sealKnowledge(ch.content, keyBytes),
            sealKnowledge(ch.excerpt, keyBytes),
            keywordHashes,
            JSON.stringify(emb),
            vectorLiteral(emb),
          ],
        );
      }

      await client.query(
        `insert into knowledge_ingestion_jobs (
           id, workspace_id, source_id, document_id, version_id, status, stage, finished_at
         ) values ($1,$2,$3,$4,$5,'succeeded','indexed', now())`,
        [jobId, valid.workspaceId, source.id, docId, versionId],
      );
      await client.query(
        `update knowledge_sources set status = 'ready', updated_at = now()
         where id = $1 and workspace_id = $2`,
        [source.id, valid.workspaceId],
      );
      await client.query(
        `delete from knowledge_answer_cache where workspace_id = $1`,
        [valid.workspaceId],
      );
      await this.#audit(client, {
        workspaceId: valid.workspaceId,
        actorUserId: valid.userId,
        action: 'document.ingest_cloud',
        entityKind: 'knowledge_document',
        entityId: docId,
        detail: { versionId, chunkCount: chunks.length, sha },
      });

      return {
        ok: true,
        documentId: docId,
        versionId,
        chunkCount: chunks.length,
        ingestionJobId: jobId,
      };
    });
  }

  /**
   * Register private-local document metadata only (no content on server).
   */
  async registerPrivateLocalDocument(scope, {
    sourceId,
    title = '',
    path = '',
    runnerContentHandle = '',
  } = {}) {
    if (!this.enabled()) reject('KNOWLEDGE_V2_DISABLED', 'Knowledge v2 disabled', 403);
    if (looksLikeAbsolutePath(path)) {
      reject('RAW_PATH_FORBIDDEN', 'raw local filesystem paths are not accepted as public knowledge metadata', 400);
    }
    const logicalPath = String(path || title || newId('local')).slice(0, 500);
    const handle = String(runnerContentHandle || newId('rch')).slice(0, 200);

    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const src = await client.query(
        `select * from knowledge_sources where workspace_id = $1 and id = $2 for update`,
        [valid.workspaceId, String(sourceId || '')],
      );
      if (!src.rowCount) reject('SOURCE_NOT_FOUND', 'source not found', 404);
      const source = src.rows[0];
      if (source.source_kind !== 'private_local') {
        reject('SOURCE_KIND_MISMATCH', 'registerPrivateLocalDocument requires private_local source', 400);
      }
      if (source.status === 'revoked') reject('SOURCE_REVOKED', 'source revoked', 410);

      const docId = newId('kdoc');
      const versionId = newId('kver');
      await client.query(
        `insert into knowledge_documents (
           id, workspace_id, source_id, collection_id, title, path, status, current_version_id, metadata
         ) values ($1,$2,$3,$4,$5,$6,'active',$7,$8::jsonb)`,
        [
          docId, valid.workspaceId, source.id, source.collection_id,
          String(title || logicalPath).slice(0, 300), logicalPath, versionId,
          JSON.stringify({ storageMode: 'runner_local', runnerContentHandle: handle }),
        ],
      );
      await client.query(
        `insert into knowledge_versions (
           id, workspace_id, document_id, source_id, version_number, content_sha256,
           storage_mode, runner_content_handle, byte_length, created_by_user_id
         ) values ($1,$2,$3,$4,1,'','runner_local',$5,0,$6)`,
        [versionId, valid.workspaceId, docId, source.id, handle, valid.userId],
      );
      // Indexable metadata chunk only (no content body).
      const emb = hashEmbedding256(`${title} ${logicalPath}`);
      await client.query(
        `insert into knowledge_chunks (
           id, workspace_id, source_id, document_id, version_id, chunk_index,
           title, path, content, excerpt, embedding, embedding_vector, status, metadata
         ) values (
           $1,$2,$3,$4,$5,0,$6,$7,'',$8,$9::jsonb,$10::vector,'active',$11::jsonb
         )`,
        [
          newId('kchk'), valid.workspaceId, source.id, docId, versionId,
          String(title || logicalPath).slice(0, 300), logicalPath,
          String(title || logicalPath).slice(0, 200),
          JSON.stringify(emb), vectorLiteral(emb),
          JSON.stringify({ runnerContentHandle: handle, privateLocal: true }),
        ],
      );
      await this.#audit(client, {
        workspaceId: valid.workspaceId,
        actorUserId: valid.userId,
        action: 'document.register_private_local',
        entityKind: 'knowledge_document',
        entityId: docId,
        detail: { versionId, runnerContentHandle: handle, path: logicalPath },
      });
      return {
        ok: true,
        documentId: docId,
        versionId,
        runnerContentHandle: handle,
        storageMode: 'runner_local',
      };
    });
  }

  async #eligibleKnowledgeRunners(client, workspaceId) {
    const rows = await client.query(
      `select id, connection_state, capabilities, status
       from runners
       where workspace_id = $1 and status = 'active' and connection_state = 'connected'`,
      [workspaceId],
    );
    return rows.rows.filter((r) => runnerHasLocalKnowledgeCapability(r.capabilities || {}));
  }

  /**
   * Hybrid search: cloud chunks on server + private_local via Runner protocol.
   */
  async search(scope, {
    query = '',
    mode = 'hybrid',
    limit = 20,
    waitForRunnerMs = 0,
    requestId = '',
  } = {}) {
    if (!this.enabled()) {
      if (this.legacyProduct) {
        const results = mode === 'vector'
          ? await this.legacyProduct.searchWikiVector(scope, query, { limit })
          : await this.legacyProduct.searchWiki(scope, query);
        return {
          ok: true, mode: 'legacy', query, results, workspaceId: scope.workspaceId,
        };
      }
      reject('KNOWLEDGE_V2_DISABLED', 'Knowledge v2 disabled', 403);
    }

    const q = String(query || '').trim();
    const cacheKey = cacheKeyFor(q);

    // Cache hit (workspace-isolated)
    const cached = await withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const row = await client.query(
        `select * from knowledge_answer_cache
         where workspace_id = $1 and cache_key = $2
           and (expires_at is null or expires_at > now())
         limit 1`,
        [valid.workspaceId, `search:${cacheKey}`],
      );
      return row.rowCount ? row.rows[0] : null;
    });
    if (cached) {
      const cacheKeyBytes = resolveKnowledgeKeyBytes(this.env);
      return {
        ok: true,
        mode: 'cache',
        query: q,
        results: cached.evidence_handle_ids || [],
        answer: cached.answer_enc && cacheKeyBytes
          ? openKnowledge(cached.answer_enc, cacheKeyBytes)
          : cached.answer,
        workspaceId: scope.workspaceId,
        cacheHit: true,
      };
    }

    const cloudResults = await this.#searchCloudChunks(scope, q, mode, limit);
    const privateSources = await withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const rows = await client.query(
        `select id from knowledge_sources
         where workspace_id = $1 and source_kind = 'private_local'
           and status in ('active','ready') and revoked_at is null`,
        [valid.workspaceId],
      );
      return rows.rows.map((r) => r.id);
    });

    let privatePart = { status: 'skipped', results: [], jobId: null };
    if (privateSources.length) {
      privatePart = await this.searchPrivateLocal(scope, {
        query: q,
        sourceIds: privateSources,
        waitForRunnerMs,
        requestId,
      });
    }

    const results = [
      ...cloudResults,
      ...(privatePart.results || []),
    ].slice(0, Math.max(1, Number(limit) || 20));

    return {
      ok: true,
      mode: mode === 'vector' ? 'vector' : 'hybrid',
      query: q,
      results,
      workspaceId: scope.workspaceId,
      privateLocal: {
        status: privatePart.status,
        jobId: privatePart.jobId || null,
        code: privatePart.code || null,
        message: privatePart.message || null,
      },
      cacheHit: false,
    };
  }

  /**
   * Private-local knowledge search via DurableExecution Runner protocol.
   */
  async searchPrivateLocal(scope, {
    query = '',
    sourceIds = [],
    waitForRunnerMs = 0,
    preferredRunnerId = null,
    requestId = '',
  } = {}) {
    assertWorkspaceScope(scope);
    if (!this.durableExecution) {
      return {
        status: 'runner_required',
        code: 'RUNNER_REQUIRED',
        message: 'durable execution not configured for private-local knowledge search',
        results: [],
      };
    }

    const eligible = await withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => (
      this.#eligibleKnowledgeRunners(client, valid.workspaceId)
    ));

    if (!eligible.length) {
      return {
        status: 'runner_required',
        code: 'RUNNER_REQUIRED',
        message: 'no eligible same-Workspace Runner with localKnowledge/knowledgeSearch capability',
        results: [],
      };
    }

    const preferred = preferredRunnerId && eligible.find((r) => r.id === preferredRunnerId);
    const runnerPick = preferred || eligible[0];
    const normalizedSourceIds = Array.isArray(sourceIds)
      ? [...new Set(sourceIds.map(String))].sort()
      : [];
    const normalizedRequestId = String(requestId || '').trim().slice(0, 200);
    const clientRequestId = normalizedRequestId
      ? `knowledge:${normalizedRequestId}`
      : `knowledge:${crypto.randomUUID()}`;
    const existing = normalizedRequestId
      ? await withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
        const found = await client.query(
          `select id, mission_id, status, payload
           from execution_jobs
           where workspace_id = $1
             and payload->>'clientRequestId' = $2
             and payload->>'kind' = 'knowledge_search'
           order by created_at desc
           limit 1`,
          [valid.workspaceId, clientRequestId],
        );
        return found.rowCount ? found.rows[0] : null;
      })
      : null;
    if (existing) {
      const existingPayload = existing.payload && typeof existing.payload === 'object'
        ? existing.payload
        : {};
      const existingSources = Array.isArray(existingPayload.sourceIds)
        ? [...new Set(existingPayload.sourceIds.map(String))].sort()
        : [];
      if (
        String(existingPayload.query || '') !== String(query || '')
        || JSON.stringify(existingSources) !== JSON.stringify(normalizedSourceIds)
      ) {
        reject(
          'KNOWLEDGE_REQUEST_ID_CONFLICT',
          'requestId already belongs to a different knowledge search',
          409,
        );
      }
      const replay = await this.getSearchJob(scope, existing.id);
      return {
        status: replay.status,
        jobId: existing.id,
        missionId: existing.mission_id,
        results: replay.results || [],
        code: replay.code || (replay.status === 'pending' ? 'KNOWLEDGE_SEARCH_PENDING' : null),
        message: replay.message || null,
        idempotentReplay: true,
      };
    }

    const work = await this.durableExecution.acceptWork(scope, {
      goal: `knowledge_search: ${String(query || '').slice(0, 200)}`,
      title: 'Knowledge search',
      executionEngine: 'knowledge',
      agentId: 'knowledge-search',
      templateId: 'knowledge-search',
      preferredRunnerId: runnerPick.id,
      payload: {
        kind: 'knowledge_search',
        query: String(query || ''),
        sourceIds: normalizedSourceIds,
        // Never put raw filesystem paths in job payload.
      },
      clientRequestId,
    });

    const jobId = work.jobId || work.work?.jobId || null;
    const missionId = work.missionId || work.work?.id || null;

    // Optional wait: poll job completion (tests may set waitForRunnerMs and drive fake adapter).
    if (waitForRunnerMs > 0 && jobId) {
      const deadline = this.clock() + waitForRunnerMs;
      while (this.clock() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        const status = await this.getSearchJob(scope, jobId);
        if (status.status === 'completed') {
          return {
            status: 'completed',
            jobId,
            missionId,
            results: status.results || [],
          };
        }
        if (status.status === 'failed') {
          return {
            status: 'failed',
            jobId,
            code: status.code || 'KNOWLEDGE_SEARCH_FAILED',
            message: status.message || 'knowledge search failed',
            results: [],
          };
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 40));
      }
    }

    return {
      status: 'pending',
      code: 'KNOWLEDGE_SEARCH_PENDING',
      message: 'knowledge search dispatched to same-Workspace Runner',
      jobId,
      missionId,
      results: [],
    };
  }

  /**
   * Materialize evidence handles from a completed knowledge_search attempt (leased/signed path).
   * Called after runner complete; also invokable when reading artifacts.
   */
  async materializeEvidenceFromJob(scope, jobId) {
    assertWorkspaceScope(scope);
    const job = await this.pool.query(
      `select j.*, a.id as attempt_id, a.lease_epoch, a.status as attempt_status,
              a.result_summary, a.runner_id
       from execution_jobs j
       left join lateral (
         select * from execution_attempts
         where workspace_id = j.workspace_id and job_id = j.id
         order by attempt_number desc limit 1
       ) a on true
       where j.workspace_id = $1 and j.id = $2
       limit 1`,
      [scope.workspaceId, String(jobId || '')],
    );
    if (!job.rowCount) reject('JOB_NOT_FOUND', 'search job not found', 404);
    const row = job.rows[0];
    if (row.status !== 'completed') {
      return {
        status: row.status === 'failed' ? 'failed' : 'pending',
        jobId: row.id,
        results: [],
      };
    }
    const jobPayload = row.payload && typeof row.payload === 'object' ? row.payload : {};
    if (
      jobPayload.kind !== 'knowledge_search'
      || !row.attempt_id
      || row.attempt_status !== 'completed'
      || !row.runner_id
      || Number(row.lease_epoch || 0) < 1
    ) {
      reject(
        'KNOWLEDGE_RUNNER_EVIDENCE_UNVERIFIED',
        'knowledge evidence requires a completed leased Runner attempt',
        409,
      );
    }
    const authorizedSourceIds = new Set(
      Array.isArray(jobPayload.sourceIds) ? jobPayload.sourceIds.map(String) : [],
    );

    // Prefer structured summary JSON; fall back to artifacts.
    let hits = [];
    try {
      const parsed = JSON.parse(row.result_summary || '{}');
      if (parsed && Array.isArray(parsed.hits)) hits = parsed.hits;
    } catch { /* ignore */ }

    if (!hits.length) {
      const arts = await this.pool.query(
        `select content from execution_artifacts
         where workspace_id = $1 and job_id = $2 and name = 'knowledge-search-evidence'
         order by created_at desc limit 1`,
        [scope.workspaceId, row.id],
      );
      if (arts.rowCount) {
        try {
          const body = JSON.parse(arts.rows[0].content || '{}');
          if (Array.isArray(body.hits)) hits = body.hits;
        } catch { /* ignore */ }
      }
    }

    const safeHits = sanitizeRunnerHits(hits);
    const keyBytes = requireKnowledgeKey(this.env);
    const evidence = await withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const out = [];
      for (const [hitIndex, hit] of safeHits.entries()) {
        const sourceId = String(hit.sourceId || '');
        if (!sourceId || !authorizedSourceIds.has(sourceId)) continue;
        // eslint-disable-next-line no-await-in-loop
        const allowed = await client.query(
          `select id from knowledge_sources
           where workspace_id = $1
             and id = $2
             and source_kind = 'private_local'
             and status <> 'revoked'
           limit 1`,
          [valid.workspaceId, sourceId],
        );
        if (!allowed.rowCount) continue;

        const handleToken = `h_${crypto.randomBytes(12).toString('hex')}`;
        const evidenceId = newId('kev');
        const evidenceKey = hashContent([
          'runner',
          row.id,
          row.attempt_id,
          hit.runnerContentHandle || '',
          hitIndex,
        ].join(':'));
        // eslint-disable-next-line no-await-in-loop
        const persisted = await client.query(
          `insert into knowledge_evidence_handles (
             id, workspace_id, source_id, document_id, version_id, chunk_id,
             runner_job_id, runner_attempt_id, evidence_key,
             handle_token, citation_label, excerpt, excerpt_enc, status
           ) values ($1,$2,$3,null,null,null,$4,$5,$6,$7,$8,'',$9,'active')
           on conflict (workspace_id, evidence_key) where evidence_key is not null
           do update set
             citation_label = excluded.citation_label,
             excerpt = '',
             excerpt_enc = excluded.excerpt_enc,
             status = 'active',
             revoked_at = null
           returning id, handle_token`,
          [
            evidenceId,
            valid.workspaceId,
            sourceId,
            row.id,
            row.attempt_id,
            evidenceKey,
            handleToken,
            hit.title || 'Knowledge',
            sealKnowledge(hit.excerpt || '', keyBytes),
          ],
        );
        const evidenceRow = persisted.rows[0];
        out.push({
          id: evidenceRow.id,
          handle: evidenceRow.handle_token,
          title: hit.title,
          excerpt: hit.excerpt,
          sourceId,
          citationLabel: hit.title || 'Knowledge',
          workspaceId: valid.workspaceId,
        });
      }
      await this.#audit(client, {
        workspaceId: valid.workspaceId,
        actorUserId: valid.userId,
        action: 'evidence.materialize',
        entityKind: 'execution_job',
        entityId: row.id,
        detail: { count: out.length, attemptId: row.attempt_id, runnerId: row.runner_id },
      });
      return out;
    });

    return { status: 'completed', jobId: row.id, results: evidence };
  }

  async getSearchJob(scope, jobId) {
    assertWorkspaceScope(scope);
    const job = await this.pool.query(
      `select id, status, goal, payload, last_error_code, last_error_message
       from execution_jobs
       where workspace_id = $1 and id = $2 limit 1`,
      [scope.workspaceId, String(jobId || '')],
    );
    if (!job.rowCount) reject('JOB_NOT_FOUND', 'search job not found', 404);
    const row = job.rows[0];
    if (row.status === 'completed') {
      return this.materializeEvidenceFromJob(scope, row.id);
    }
    if (['failed', 'cancelled', 'dead_letter'].includes(row.status)) {
      return {
        status: 'failed',
        jobId: row.id,
        code: row.last_error_code || 'KNOWLEDGE_SEARCH_FAILED',
        message: row.last_error_message || row.status,
        results: [],
      };
    }
    return {
      status: 'pending',
      jobId: row.id,
      code: 'KNOWLEDGE_SEARCH_PENDING',
      results: [],
    };
  }

  async #searchCloudChunks(scope, q, mode, limit) {
    const keyBytes = resolveKnowledgeKeyBytes(this.env);
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      if (!q) return [];
      if (!keyBytes) {
        const configured = await client.query(
          `select 1 from knowledge_sources
           where workspace_id = $1
             and source_kind = 'cloud_indexed'
             and status in ('active','ready')
             and revoked_at is null
           limit 1`,
          [valid.workspaceId],
        );
        if (configured.rowCount) {
          reject(
            'KNOWLEDGE_VAULT_KEY_REQUIRED',
            'cloud-indexed knowledge cannot be read without its encryption key',
            503,
          );
        }
        return [];
      }
      let rows;
      if (mode === 'vector') {
        const emb = hashEmbedding256(q);
        rows = await client.query(
          `select c.id, c.title, c.path, c.content_enc, c.excerpt_enc,
                  c.source_id, c.document_id, c.version_id, c.workspace_id,
                  (c.embedding_vector <=> $2::vector) as vector_distance
           from knowledge_chunks c
           inner join knowledge_sources s
             on s.id = c.source_id and s.workspace_id = c.workspace_id
           where c.workspace_id = $1
             and c.status = 'active'
             and s.status <> 'revoked'
             and s.revoked_at is null
             and s.source_kind = 'cloud_indexed'
             and c.embedding_vector is not null
           order by c.embedding_vector <=> $2::vector
           limit $3`,
          [valid.workspaceId, vectorLiteral(emb), Math.max(1, Number(limit) || 20)],
        );
      } else {
        const keywordHashes = hashKnowledgeTokens(q, keyBytes);
        if (!keywordHashes.length) return [];
        rows = await client.query(
          `select c.id, c.title, c.path, c.content_enc, c.excerpt_enc,
                  c.source_id, c.document_id, c.version_id, c.workspace_id
           from knowledge_chunks c
           inner join knowledge_sources s
             on s.id = c.source_id and s.workspace_id = c.workspace_id
           where c.workspace_id = $1
             and c.status = 'active'
             and s.status <> 'revoked'
             and s.revoked_at is null
             and s.source_kind = 'cloud_indexed'
             and c.keyword_hashes && $2::text[]
           order by c.updated_at desc
           limit $3`,
          [valid.workspaceId, keywordHashes, Math.max(1, Number(limit) || 20)],
        );
      }

      const out = [];
      for (const row of rows.rows) {
        const excerpt = openKnowledge(row.excerpt_enc || row.content_enc, keyBytes).slice(0, 280);
        const evidenceKey = hashContent(`cloud:${row.id}`);
        const handleToken = `h_${crypto.randomBytes(12).toString('hex')}`;
        const evidenceId = newId('kev');
        // eslint-disable-next-line no-await-in-loop
        const evidenceRow = await client.query(
          `insert into knowledge_evidence_handles (
             id, workspace_id, source_id, document_id, version_id, chunk_id,
             evidence_key, handle_token, citation_label, excerpt, excerpt_enc, status
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'',$10,'active')
           on conflict (workspace_id, evidence_key) where evidence_key is not null
           do update set
             citation_label = excluded.citation_label,
             excerpt = '',
             excerpt_enc = excluded.excerpt_enc,
             status = 'active',
             revoked_at = null
           returning id, handle_token`,
          [
            evidenceId, valid.workspaceId, row.source_id, row.document_id || null,
            row.version_id || null, row.id, evidenceKey, handleToken,
            row.title || 'Knowledge',
            sealKnowledge(excerpt, keyBytes),
          ],
        );
        const persisted = evidenceRow.rows[0];
        out.push({
          id: persisted.id,
          handle: persisted.handle_token,
          title: row.title,
          excerpt,
          sourceId: row.source_id,
          documentId: row.document_id,
          citationLabel: row.title || 'Knowledge',
          workspaceId: valid.workspaceId,
          vectorDistance: row.vector_distance != null ? Number(row.vector_distance) : undefined,
        });
      }
      return out;
    });
  }

  async ask(scope, { question = '', waitForRunnerMs = 0, requestId = '' } = {}) {
    const q = String(question || '').trim();
    if (!this.enabled()) {
      if (this.legacyProduct) {
        return this.legacyProduct.askWikiScoped(scope, q);
      }
      reject('KNOWLEDGE_V2_DISABLED', 'Knowledge v2 disabled', 403);
    }

    // Prompt-injection strings must not bypass workspace scope (enforced by RLS + scope only).
    const search = await this.search(scope, {
      query: q,
      mode: 'hybrid',
      waitForRunnerMs,
      requestId,
    });
    const searchedCitations = (search.results || []).map((r) => ({
      handle: r.handle || r.id,
      title: r.title || r.citationLabel,
      excerpt: r.excerpt,
      sourceId: r.sourceId,
    })).filter((citation) => citation.handle);
    const authorize = async (citations) => {
      const authorized = [];
      for (const citation of citations) {
        try {
          const evidence = await this.resolveEvidence(scope, citation.handle);
          authorized.push({
            handle: evidence.handle,
            title: evidence.title,
            excerpt: evidence.excerpt,
            sourceId: evidence.sourceId,
          });
        } catch (error) {
          if (!['EVIDENCE_NOT_FOUND', 'EVIDENCE_REVOKED'].includes(error?.code)) throw error;
        }
      }
      return authorized;
    };
    let citations = await authorize(searchedCitations);

    let answer;
    if (
      search.cacheHit
      && search.answer
      && citations.length === searchedCitations.length
    ) {
      answer = {
        text: search.answer,
        status: 'ok',
      };
    } else if (search.privateLocal?.status === 'runner_required' && !(search.results || []).length) {
      answer = {
        text: 'Private-local knowledge requires an eligible Workspace Runner with local knowledge capability.',
        status: 'runner_required',
        code: 'RUNNER_REQUIRED',
      };
    } else if (search.privateLocal?.status === 'pending' && !(search.results || []).length) {
      answer = {
        text: 'Knowledge search is pending on a Workspace Runner.',
        status: 'pending',
        code: 'KNOWLEDGE_SEARCH_PENDING',
        jobId: search.privateLocal.jobId,
      };
    } else if (citations.length && this.inferenceBroker) {
      const complete = async (evidence, suffix = '') => this.inferenceBroker.complete({
        scope,
        purpose: 'wiki_ai',
        requestId: `${String(requestId || crypto.randomUUID())}${suffix}`,
        messages: [
          {
            role: 'system',
            content: [
              '현재 요청 Workspace에서 허용된 근거만 사용해 답하세요.',
              '근거에 없는 사실을 만들거나 다른 Workspace의 정보를 요청하지 마세요.',
              ...evidence.map((item, index) => (
                `[근거 ${index + 1}] ${item.title}\n${item.excerpt}`
              )),
            ].join('\n\n').slice(0, 12_000),
          },
          { role: 'user', content: q },
        ],
        context: {
          citations: evidence.map((item) => ({
            handle: item.handle,
            title: item.title,
            sourceId: item.sourceId,
          })),
        },
      });
      try {
        let completion = await complete(citations);
        const revalidated = await authorize(citations);
        const originalHandles = citations.map((item) => item.handle).join(':');
        const finalHandles = revalidated.map((item) => item.handle).join(':');
        if (originalHandles !== finalHandles) {
          if (!revalidated.length) {
            answer = {
              text: 'No currently authorized workspace knowledge passages matched this question.',
              status: 'empty',
              code: 'KNOWLEDGE_EVIDENCE_CHANGED',
            };
          } else {
            completion = await complete(revalidated, ':evidence-revalidated');
            citations = await authorize(revalidated);
            if (citations.length !== revalidated.length) {
              reject(
                'KNOWLEDGE_EVIDENCE_CHANGED',
                'Knowledge evidence authorization changed during answer synthesis',
                409,
              );
            }
          }
        } else {
          citations = revalidated;
        }
        if (!answer) {
          answer = {
            text: completion.text,
            status: 'ok',
          };
        }
      } catch (error) {
        answer = {
          text: 'Wiki AI inference is unavailable for this Workspace.',
          status: 'unavailable',
          code: error.code || 'WORKSPACE_INFERENCE_UNAVAILABLE',
        };
      }
    } else if (citations.length) {
      answer = {
        text: 'Wiki AI inference is unavailable for this Workspace.',
        status: 'unavailable',
        code: 'WORKSPACE_INFERENCE_UNAVAILABLE',
      };
    } else {
      answer = {
        text: 'No workspace knowledge passages matched this question.',
        status: 'empty',
      };
    }

    // Cache only terminal successful answers (not pending/runner_required)
    const cacheKeyBytes = resolveKnowledgeKeyBytes(this.env);
    if ((answer.status === 'ok' || answer.status === 'empty') && cacheKeyBytes) {
      const cachedCitations = citations.map((citation) => ({
        handle: citation.handle,
        title: citation.title,
        sourceId: citation.sourceId,
      }));
      await withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
        await client.query(
          `insert into knowledge_answer_cache (
             id, workspace_id, cache_key, question, answer, answer_enc,
             evidence_handle_ids, expires_at
           ) values ($1,$2,$3,$4,'',$5,$6::jsonb, now() + interval '1 hour')
           on conflict (workspace_id, cache_key) do update set
             answer = '',
             answer_enc = excluded.answer_enc,
             evidence_handle_ids = excluded.evidence_handle_ids,
             expires_at = excluded.expires_at`,
          [
            newId('kcache'),
            valid.workspaceId,
            `search:${cacheKeyFor(q)}`,
            q,
            sealKnowledge(answer.text, cacheKeyBytes),
            JSON.stringify(cachedCitations),
          ],
        );
      });
    }

    return {
      ok: true,
      answer: answer.text,
      answerStatus: answer.status,
      code: answer.code || null,
      jobId: answer.jobId || search.privateLocal?.jobId || null,
      citations,
      results: citations,
      mode: 'knowledge_v2',
      workspaceId: scope.workspaceId,
      privateLocal: search.privateLocal || null,
    };
  }

  /**
   * Resolve opaque evidence handle — workspace-bound only.
   */
  async resolveEvidence(scope, handleOrId) {
    assertWorkspaceScope(scope);
    const token = String(handleOrId || '').trim();
    if (!token) reject('EVIDENCE_HANDLE_REQUIRED', 'evidence handle required', 400);
    if (looksLikeAbsolutePath(token)) {
      reject('RAW_PATH_FORBIDDEN', 'raw paths are not valid evidence handles', 400);
    }
    return withAppRoleWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const row = await client.query(
        `select e.*, s.status as source_status, s.revoked_at
         from knowledge_evidence_handles e
         inner join knowledge_sources s
           on s.id = e.source_id and s.workspace_id = e.workspace_id
         where e.workspace_id = $1
           and (e.handle_token = $2 or e.id = $2)
         limit 1`,
        [valid.workspaceId, token],
      );
      if (!row.rowCount) {
        reject('EVIDENCE_NOT_FOUND', 'evidence handle unknown in this workspace', 404);
      }
      const e = row.rows[0];
      if (e.status === 'revoked' || e.revoked_at || e.source_status === 'revoked') {
        reject('EVIDENCE_REVOKED', 'evidence handle revoked', 410);
      }
      const keyBytes = resolveKnowledgeKeyBytes(this.env);
      const excerpt = e.excerpt_enc
        ? openKnowledge(e.excerpt_enc, keyBytes || requireKnowledgeKey(this.env))
        : e.excerpt;
      return {
        ok: true,
        handle: e.handle_token,
        id: e.id,
        title: e.citation_label,
        excerpt,
        sourceId: e.source_id,
        workspaceId: valid.workspaceId,
        // Never return content body or absolute paths
      };
    });
  }

  async revokeSource(scope, sourceId) {
    if (!this.enabled()) reject('KNOWLEDGE_V2_DISABLED', 'Knowledge v2 disabled', 403);
    return withWorkspaceTransaction(this.pool, scope, async (client, valid) => {
      const src = await client.query(
        `select * from knowledge_sources where workspace_id = $1 and id = $2 for update`,
        [valid.workspaceId, String(sourceId || '')],
      );
      if (!src.rowCount) reject('SOURCE_NOT_FOUND', 'source not found', 404);
      const source = src.rows[0];
      const now = new Date(this.clock()).toISOString();
      await client.query(
        `update knowledge_sources
         set status = 'revoked', revoked_at = $3::timestamptz, updated_at = now()
         where id = $1 and workspace_id = $2`,
        [source.id, valid.workspaceId, now],
      );
      await client.query(
        `update knowledge_chunks set status = 'revoked', updated_at = now()
         where workspace_id = $1 and source_id = $2`,
        [valid.workspaceId, source.id],
      );
      await client.query(
        `update knowledge_documents set status = 'revoked', updated_at = now()
         where workspace_id = $1 and source_id = $2`,
        [valid.workspaceId, source.id],
      );
      await client.query(
        `update knowledge_evidence_handles
         set status = 'revoked', revoked_at = $3::timestamptz
         where workspace_id = $1 and source_id = $2`,
        [valid.workspaceId, source.id, now],
      );
      // Purge answer cache for workspace (isolation + immediate revoke)
      await client.query(
        `delete from knowledge_answer_cache where workspace_id = $1`,
        [valid.workspaceId],
      );
      await client.query(
        `delete from knowledge_object_blobs where workspace_id = $1 and source_id = $2`,
        [valid.workspaceId, source.id],
      );

      await this.#audit(client, {
        workspaceId: valid.workspaceId,
        actorUserId: valid.userId,
        action: 'source.revoke',
        entityKind: 'knowledge_source',
        entityId: source.id,
        detail: { path: source.path },
      });
      return { ok: true, sourceId: source.id, status: 'revoked' };
    });
  }

  #chunkText(text, title) {
    const body = String(text || '');
    const size = 800;
    const chunks = [];
    for (let i = 0; i < body.length; i += size) {
      const content = body.slice(i, i + size);
      chunks.push({
        title: String(title || 'Document').slice(0, 200),
        content,
        excerpt: content.slice(0, 280),
      });
    }
    return chunks.length ? chunks : [{ title, content: '', excerpt: '' }];
  }

  #publicCollection(row) {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      description: row.description,
      status: row.status,
    };
  }

  #publicSource(row) {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      collectionId: row.collection_id,
      sourceKind: row.source_kind,
      label: row.label,
      path: row.path,
      status: row.status,
      cloudOptIn: row.cloud_opt_in,
      encryptionRequired: row.encryption_required,
      runnerRequired: row.runner_required,
      revokedAt: row.revoked_at,
      lastErrorCode: row.last_error_code || '',
      lastErrorMessage: row.last_error_message || '',
    };
  }
}

module.exports = {
  KnowledgeService,
  knowledgeV2Enabled,
  cacheKeyFor,
};
