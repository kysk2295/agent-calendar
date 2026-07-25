# Plan: Phase 6 Conversational Calendar AI

- Date: 2026-07-24
- Owner: root (Grok worker quota exhausted; existing worker session retained)
- Work size: Large | Boundary
- Status: Verified

## Goal

Replace the production Workspace schedule-summary stub with a persistent, natural Calendar AI that
can converse normally, answer exact questions from the complete authorized Unified Calendar,
retain only explicit Personal Memory, prepare typed calendar changes, and delegate accountable
work without allowing model output or retrieved content to authorize capabilities.

## Non-goals

- Automation federation and automation write tools (Phase 7)
- Mobile UI (final product phase)
- Hidden profiling or automatic memory extraction
- Direct database access by a model
- Unsupported external send, publish, purchase, or delete actions
- Cross-Workspace conversation or memory sharing

## Work size

Large and Boundary. This changes DB meaning, authenticated routes, model contracts, Unified
Calendar reads, DurableExecution writes, and the Desktop Calendar AI surface.

## Touched boundaries

- DB: `apps/backend/app/db/migrations/0023_calendar_ai.sql`
- Backend: Calendar AI service, context assembler, model adapter, production route registry/handler
- Existing services: Unified Calendar, Knowledge v2, DurableExecution, scoped product calendar CRUD
- Desktop: ChatDrawer, Calendar AI API/SSE parsing, action and memory controls
- Tests: backend hostile matrix, parser/contract tests, two-account Electron ETE
- Docs/evidence: this plan and Phase 6 evidence JSON

## Success criteria

- [x] Ordinary Korean conversation does not force calendar or Knowledge retrieval.
- [x] Exact schedule questions use the complete authorized range and deterministic counting rather
      than semantic top-k or model arithmetic.
- [x] Every schedule answer includes requested range and per-source coverage.
- [x] Conversation, turns, snapshots, memory, drafts, and receipts survive restart and are
      Workspace-isolated under FORCE RLS.
- [x] Personal Memory is created only by explicit user request, has provenance, is reviewable and
      editable, and disappears immediately after forget/purge.
- [x] Calendar create/update/delete uses a typed Action Draft, policy result, explicit approval,
      idempotent execution, and a source-confirmed receipt.
- [x] Delegated Work approval creates at most one DurableExecution job and links it to the Calendar
      AI conversation.
- [x] Model output, Knowledge content, and prompt injection cannot grant a tool or execute an action.
- [x] Cloud OpenAI and local/Runner model paths can be disabled independently; inference failure
      leaves manual calendar use and readable conversation history intact.
- [x] Desktop shows natural turns, streaming state, citations/coverage, memory controls, Action
      Draft approval/revision/error, and linked Delegated Work.
- [x] Two clean accounts pass conversation, exact query, memory, action, work, isolation, and
      restart/reconnect ETE on the real Desktop surface.

## Edge cases

- Same request ID retried concurrently
- Same event title in two Workspaces
- Empty or partial external-calendar coverage
- Ambiguous update/delete target
- Model asks for multiple tool calls
- Retrieved text contains tool JSON or approval-bypass instructions
- Memory forget races with an in-flight turn
- Action approval is replayed after success
- Runner is absent when approved Delegated Work is accepted
- Model provider is unavailable or times out

## Test plan

1. RED: migration/RLS, two-Workspace conversation/memory/action isolation, idempotency.
2. RED: ordinary chat retrieves no calendar; exact range reads all entries and coverage.
3. RED: explicit remember/edit/forget/purge and no implicit memory.
4. RED: create/update/delete Action Draft approval and receipt; injection cannot execute.
5. RED: Delegated Work link and same-request replay creates one job.
6. GREEN: minimal service, adapters, routes, then Desktop presentation.
7. ETE: two accounts plus backend/Desktop restart and screenshots.

## Acceptance gates

- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [x] Phase 6 Playwright ETE
- [x] Manual screenshot QA
- [x] No orphan worker or test process

## Step-by-step checklist

- [x] Migration 0023 and scoped repositories
- [x] Model adapter and ContextAssembler
- [x] Persistent conversation and streaming route
- [x] Exact schedule answer and coverage
- [x] Personal Memory lifecycle
- [x] Calendar Action Draft/policy/approval/receipt
- [x] Delegated Work draft/approval/link/replay
- [x] Desktop Calendar AI surface
- [x] Hostile tests, ETE, full gates, evidence

## Rollback and fallback

- `CALENDAR_AI_V2_ENABLED=0` returns to the existing readable calendar assistant path.
- `CALENDAR_AI_ACTIONS_ENABLED=0` keeps conversation and exact reads but disables all drafts.
- `CALENDAR_AI_CLOUD_MODEL_ENABLED=0` disables cloud inference independently.
- `CALENDAR_AI_RUNNER_MODEL_ENABLED=0` disables local/Runner inference independently.
- No rollback deletes conversations, memories, drafts, or receipts.

## Remaining risks

- Production OpenAI credentials are an external deployment prerequisite.
- A live external calendar may report incomplete coverage; the answer must remain explicit rather
  than silently treating missing coverage as no events.
- Runner conversational completion uses a hidden durable job so provider credentials remain on the
  customer host. The queue, Workspace isolation, result wait, and cloud fallback are covered; a live
  installed Codex/Claude/Grok/Hermes provider run remains an environment-specific release check.
- The PostgreSQL app-role client must stay on the current sequential-query pattern when upgraded to
  `pg` 9; Phase 6 removed the previously observed concurrent-client deprecation warning.

## Verification notes

- Backend: 406/406 tests passed, including real PostgreSQL RLS, exact range, explicit memory,
  prompt-injection rejection, create/update/delete receipts, Runner queue/result completion, and
  one-job Delegated Work replay.
- Desktop: 183/183 tests passed; Runner: 19/19 tests passed.
- `npm test` and `npm run build:desktop` both exited 0.
- `apps/desktop/tests/playwright-phase6-calendar-ai.cjs` exited 0 with two clean WorkOS-style
  accounts. Workspace B received 404 for Workspace A's conversation; A owned one created event and
  one delegated job while B owned neither.
- Server and Desktop restart restored the conversation, completed Action Drafts, and memory. Forget
  persisted, the memory became unavailable to later model context, and permanent deletion remained
  available in the user-visible memory panel.
- Manual review confirmed the action approval card, empty isolated account, restored action history,
  correct `팀 회의` calendar title, and forgotten-memory deletion control.
- Evidence: `docs/operations/evidence/2026-07-24-phase6-calendar-ai.json`.
