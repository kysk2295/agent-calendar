# Plan: Phase 5 Knowledge v2 and Wiki AI Isolation

- Date: 2026-07-24
- Owner: Grok + root verification
- Work size: Large | Boundary
- Status: Verified

## Goal

Workspace-scoped Knowledge v2: collections, sources, immutable versions, chunks, ingestion,
hybrid retrieval, opaque evidence handles, revocation, audit/provenance, and cache isolation so
personal Wiki/knowledge is safe for Calendar AI without cross-Workspace or raw-path leakage.

## Non-Goals

- Live object storage (S3) product proof — fail closed / encrypted DB ciphertext only (no fake “uploaded to S3”)
- Live Mac mini / external host execution of private-local search — may remain unexercised; **protocol + fake Runner adapter must pass E2E**
- Full Conversational Calendar AI (Phase 6)
- Live cloud provider connectors (Drive/Notion)

## Private-local protocol (required for Verified)

- Enqueue `knowledge_search` via existing DurableExecution job/offer/lease/attempt contracts.
- Dispatch **only** to an eligible same-Workspace Runner (`capabilities.localKnowledge` / `knowledgeSearch`).
- Accept evidence only from a signed/leased attempt (device auth + lease epoch).
- Persist metadata + opaque evidence handle + snippet policy only — **never** raw local paths or full content.
- When no eligible Runner: return truthful `runner_required` (not a silent empty success).
- When job accepted but not yet complete: return truthful `pending` + `jobId`.
- Injected **fake Runner adapter** in tests drives next-offer → lease → evidence artifact → complete; two-Runner ownership/restart/replay covered.

## Touched Boundaries

- Backend gateway: `production-route-registry.js`, `production-product-routes.js`, `phase1-auth-routes.js`
- Backend library: `knowledge-service.js`, `knowledge-crypto.js`
- DB/migrations: `0022_knowledge_v2.sql` (next number after 0021; not roadmap “0015”)
- Electron bridge: none required beyond existing API proxy
- React UI: `hermesApi.ts`, WikiScreen truthful knowledge/citation/revoked states
- Tests: `phase5-knowledge-v2.test.cjs`, Playwright ETE
- Docs: this plan + evidence JSON

## Success Criteria

- [x] Two Workspaces with identical paths cannot observe each other
- [x] Keyword, vector, evidence, cache, and citation paths enforce Workspace scope
- [x] Revocation removes content from new answers immediately
- [x] Legacy Wiki remains readable behind `KNOWLEDGE_V2_ENABLED=0` / rollback until parity
- [x] Cloud-indexed sources: explicit opt-in + 32-byte key AES-GCM + fail closed
- [x] Private-local: metadata/handles only on server; `RUNNER_REQUIRED` without eligible Runner; never accept raw local paths as public evidence
- [x] Cloud source bodies, chunk excerpts, citation excerpts, and derived answer caches contain no plaintext at rest
- [x] Cloud ingestion commits source/version/chunks/blob/cache invalidation atomically or leaves no partial searchable state
- [x] Re-reading one completed Runner search returns the same evidence handles without creating duplicates
- [x] Runner evidence is accepted only for the completed leased attempt and source IDs authorized by the original search job
- [x] Desktop Wiki shows truthful source/citation/revoked/error states
- [x] ETE + full gates green; honest evidence

## Edge Cases

- Same filename/path in ws-a and ws-b
- Direct evidence handle ID resolution cross-workspace
- Prompt injection strings in content must not authorize foreign workspace or bypass revoke
- Keyword + vector + answer-cache isolation after revoke
- Restart survives isolation
- Rollback flag restores legacy wiki path

## Test Plan

- RED:
  - [x] Hostile two-workspace matrix
  - [x] Same-path isolation
  - [x] Keyword/vector/cache/evidence direct-ID
  - [x] Prompt injection
  - [x] Revocation
  - [x] Plaintext-at-rest scan across chunks, evidence, cache, and blobs
  - [x] Blob-write failure rollback with no partial searchable document/version/chunk
  - [x] Completed Runner job evidence materialization replay returns stable handles
  - [x] Runner hit cannot substitute a source outside the job's authorized source set
  - [x] Restart / rollback legacy parity
  - [x] Runner ownership / private-local
- GREEN:
  - [x] Minimal KnowledgeService + migration + routes + Desktop + ETE
- REFACTOR:
  - [x] Keep tests green only

## Acceptance Gates

- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [x] Playwright ETE phase5 knowledge
- [x] No orphan workers

## Implementation Checklist

- [x] Plan + migration 0022
- [x] knowledge-crypto + knowledge-service
- [x] Routes + runtime wire
- [x] Backend tests RED→GREEN
- [x] Desktop hermesApi + Wiki presentation
- [x] Playwright ETE + screenshots
- [x] Evidence JSON + verified status

## Verification Notes

- `npm run backend:check`: pass
- `npm run test:backend`: 403/403 pass
- `npm run typecheck`: pass
- `npm --workspace apps/desktop run test`: 182/182 pass
- `npm run build:desktop`: pass
- `npm test`: backend 403 + Desktop 182 + Runner 19 pass
- `node apps/desktop/tests/playwright-phase5-knowledge-v2.cjs`: verified, exit 0
- Evidence: `docs/operations/evidence/2026-07-24-phase5-knowledge-v2.json`
- Manual QA: Workspace A answer/citation, Workspace B isolation, revoked source, restart state screenshots inspected

### Root audit findings after the first GREEN

- `knowledge_chunks.content` and `knowledge_chunks.excerpt` still store cloud document plaintext,
  despite the encrypted blob boundary.
- `knowledge_answer_cache.answer` and `knowledge_evidence_handles.excerpt` can retain derived
  plaintext from cloud content.
- Cloud document rows commit in an app-role transaction before the service-owned blob insert, so a
  blob failure can leave a ready/searchable partial ingestion.
- `materializeEvidenceFromJob` creates fresh evidence handles on every poll and does not bind a
  materialized hit to a stable job/attempt evidence key.
- New ingestion does not invalidate an existing workspace answer cache.
- Revoked sources are filtered out of source listings, preventing the Desktop from presenting the
  truthful revoked state.

## Remaining Risks

- Risk: Live Mac mini private-local content retrieval is not exercised in CI
  - Mitigation: Production Runner now owns a dedicated `knowledge` adapter and local source registry; device-auth protocol and fake adapter prove ownership/replay, while an external Mac mini remains an honest non-claim
- Risk: Embedding quality is hash-based (parity with legacy hermes-hash)
  - Mitigation: Same model id; hybrid keyword still authoritative for isolation tests
- Risk: keyword overlap can surface a low-relevance same-Workspace passage for shared terms
  - Mitigation: evidence remains correctly Workspace-scoped; Phase 6 context assembly must rank or threshold before conversational synthesis
- Risk: Knowledge-search jobs create mission/session rows (shared durable ledger)
  - Mitigation: `templateId=knowledge-search` + payload.kind; UI can ignore as non-work; rollback flag keeps legacy wiki
- Risk: Node PG reports a non-fatal concurrent `client.query()` deprecation warning in some existing integration paths
  - Mitigation: all gates are green; track before the repository upgrades to pg 9
