# Plan: Knowledge and Communication domain refactor

- Date: 2026-07-23
- Owner: Codex
- Work size: Large / Boundary-preserving
- Status: Complete

## Goal

Continue the domain-oriented refactor by moving Knowledge and Communication rules and screens out of `apps/desktop/src/App.tsx`. Preserve the current HTTP, SSE, Electron, persistence, CSS, accessibility, and user-visible workflow contracts while leaving `App.tsx` responsible for application composition and cross-domain orchestration.

## Non-goals

- No backend route, response schema, SSE event, IPC channel, database meaning, or deployment change.
- No visual redesign of Wiki, Diary, Review, Notes, Mail, or Calendar AI.
- No rewrite of the Wiki graph algorithm or chat/mail state model.
- No generic shared-utils package and no speculative port with only one adapter.
- No change to Telegram behavior; Telegram remains backend-owned.
- No deletion or rewrite of the user's existing Relay run-action and chat auto-scroll changes.
- No deletion or rewrite of the concurrently added voice morning-briefing, speech input/output, styles, tests, or plan.

## Work size

Large. The change moves more than one thousand lines across React presentation, pure domain rules, source-inspection contracts, and UI workflows. External boundaries remain stable, but the desktop composition seam and test ownership move.

## Touched boundaries

- Desktop composition: `apps/desktop/src/App.tsx`
- Knowledge domain: `apps/desktop/src/domains/knowledge/**`
- Communication domain: `apps/desktop/src/domains/communication/**`
- Knowledge features: `apps/desktop/src/features/knowledge/**`
- Communication features: `apps/desktop/src/features/communication/**`
- Contracts and tests: `apps/desktop/tests/**`
- Architecture docs: `CONTEXT-MAP.md`, this plan
- Backend, Electron bridge, DB, widget integration: unchanged

## Target module map

- Knowledge domain
  - Document identity and create-response normalization
  - Wiki envelope and journal normalization
  - Deterministic graph edge/layout rules
  - Wiki SSE block parsing and accumulated answer metadata
- Knowledge features
  - Notes, Review, Wiki, and Diary screens
  - React-only graph interaction and document detail loading
- Communication domain
  - Calendar chat history and schedule-ingest normalization
  - Schedule draft registration mapping
  - Image attachment policy
  - Mail presentation, optimistic updates, Gmail connection and sync normalization
- Communication features
  - Mail screen
  - Calendar AI drawer and schedule draft cards
- App composition
  - Owns cross-domain state, hydration, API invocation, persistence callbacks, and navigation

Dependency direction: `App composition -> feature modules -> domain modules`. Domain modules must not import React, `hermesApi`, or `App.tsx`. Feature modules must not import `App.tsx`.

## Success criteria

- [x] Knowledge and Communication rules have testable domain interfaces outside `App.tsx`.
- [x] Wiki, Diary, Review, Notes, Mail, Chat Drawer, and Schedule Draft Cards render from feature modules.
- [x] `App.tsx` keeps state ownership and orchestration without duplicate domain or screen implementations.
- [x] Wiki SSE ordering, sources, metadata, empty-answer, and error copy remain unchanged.
- [x] Chat history filtering, attachment policy, ingest drafts, streaming interruption, and auto-scroll remain unchanged.
- [x] Voice morning briefing, speech recognition, answer narration, and chat busy-state behavior remain unchanged while `ChatDrawer` moves.
- [x] Mail optimistic task/archive/star behavior, rollback, Gmail sync, and active selection remain unchanged.
- [x] Existing HTTP, SSE, IPC, widget, persistence, CSS class, and accessibility contracts remain unchanged.
- [x] User-owned uncommitted changes remain present.
- [x] Narrow tests, full tests, typecheck, desktop build, and representative UI workflows pass.

## Edge cases

- Wiki event blocks may be split across stream chunks or use CRLF; accumulated delta text must not duplicate the final answer.
- Wiki source and metadata events may arrive before or after answer deltas.
- Empty Wiki terminal answers must retain the current Korean fallback copy.
- Journal summaries may need lazy path-based detail loading and identity-based merging.
- Wiki graph input may have missing edges, duplicate aliases, orphan nodes, or a reference-vault filename that must not affect layout.
- Calendar chat history must include only `target === 'calendar'` records.
- Image attachments accept only PNG, JPEG, or HEIC and at most 10 MiB.
- Schedule drafts with missing title/date or deselected state must not persist.
- Mail action failure must restore the exact previous inbox and active selection.
- Gmail sync must reject an empty response while accepting either returned items or an explicit count.

## Test plan

### RED

- [x] Add Knowledge interface tests before its modules exist.
- [x] Add Communication interface tests before its modules exist.
- [x] Confirm both narrow tests fail for missing modules/exports.

### GREEN

- [x] Implement the smallest pure Knowledge functions that satisfy the interface tests.
- [x] Implement the smallest pure Communication functions that satisfy the interface tests.
- [x] Run each narrow test and desktop typecheck after its module lands.

### REFACTOR

- [x] Move screens to feature modules without changing markup, CSS classes, callback contracts, or state position.
- [x] Replace source-inspection ownership so tests inspect the new module that owns each behavior.
- [x] Remove duplicate `App.tsx` implementations only after imports compile and narrow tests pass.

## Step-by-step checklist

- [x] Characterize document/wiki/journal/graph/SSE behavior through the Knowledge interface.
- [x] Characterize calendar chat/drafts/attachments/mail behavior through the Communication interface.
- [x] Extract Knowledge pure modules and pass their narrow tests.
- [x] Extract Communication pure modules and pass their narrow tests.
- [x] Move Wiki, Diary, Notes, and Review screens into Knowledge feature modules.
- [x] Move Mail, Chat Drawer, and Schedule Draft Cards into Communication feature modules.
- [x] Wire feature modules from `App.tsx` and remove duplicate implementations.
- [x] Inject Knowledge document loading from `App.tsx` so feature modules stay transport-independent.
- [x] Update brittle source-contract tests to inspect the owning modules.
- [x] Run narrow, desktop, full repository, build, and UI workflow gates.
- [x] Record final line-count reduction, verification results, and remaining risks.

## Independent ownership and ordering

- Knowledge pure modules and tests may be implemented independently from Communication pure modules and tests.
- Knowledge feature files and Communication feature files may be prepared independently after their domain interfaces exist.
- `App.tsx`, shared source-contract tests, and final integration have one owner to prevent conflicting removals.
- Each parallel worker owns only its assigned new domain/feature files and tests and must not edit `App.tsx`.

## Acceptance gates

- [x] Knowledge domain narrow tests
- [x] Communication domain narrow tests
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm test`
- [x] `npm run build:desktop`
- [x] `node apps/desktop/tests/playwright-wiki-graph-layout.cjs`
- [x] `node apps/desktop/tests/playwright-wiki-session-turn-stream.cjs`
- [x] `node apps/desktop/tests/playwright-diary-journal.cjs`
- [x] `node apps/desktop/tests/playwright-chat-autoscroll.cjs`
- [x] `node apps/desktop/tests/playwright-calendar-chat-stream-interruption.cjs`
- [x] `node apps/desktop/tests/playwright-voice-morning-briefing.cjs`
- [x] `node apps/desktop/tests/playwright-mail-actions.cjs`
- [x] `node apps/desktop/tests/playwright-mail-star-failure-rollback.cjs`
- [x] `node apps/desktop/tests/playwright-mail-archive-failure-selection.cjs`

## Rollback and fallback story

- Pure-domain extraction is reversible by restoring the inline helpers and removing only the new domain imports/files.
- Feature extraction is reversible per screen because `App.tsx` callback signatures and state ownership remain unchanged.
- If a UI workflow exposes a state-position regression, restore that screen definition to `App.tsx` without rolling back already-passing pure modules.
- Never reset the working tree; preserve the first-tranche domain files, backend Relay work, release-blocker tests, and chat auto-scroll behavior.

## Verification notes

- Baseline before this tranche: backend 290 passed, desktop 146 passed, typecheck/build and selected UI workflows passed.
- RED evidence: both new domain tests initially failed because their target modules did not exist; the Knowledge loader-boundary contract later failed while feature modules still imported `hermesApi` directly.
- Final narrow domain result: 13 passed.
- Final desktop result: 162 passed.
- Final backend result: 290 passed; backend syntax check passed.
- Full repository `npm test`: 452 passed.
- Desktop typecheck and production build passed.
- All nine representative Knowledge, Communication, mail rollback, chat streaming/scrolling, and voice Playwright workflows passed.
- `App.tsx` moved from 5,267 to 3,771 lines in this tranche (1,496-line reduction), and from 5,736 to 3,771 lines across the complete domain-oriented refactor (1,965-line reduction).
- `git diff --check` passed. The recurring `Port 24678 is already in use` diagnostic did not fail typecheck or tests.

## Remaining risks

- `App.tsx` will still own cross-domain hydration and mutations after this tranche; extracting controller hooks should be a later, separately tested change.
- `WikiScreen.tsx` remains a large presentation/interaction module; split its graph, tree, and reader subcomponents in a later UI-only tranche rather than mixing that state migration into this domain-boundary change.
- Search and widget screens intentionally remain in `App.tsx` because they combine multiple domains.
- Some historical tests still inspect implementation source; the assertions touched here now follow the module that actually owns each contract, without weakening the behavioral checks.
