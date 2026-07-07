# Agent Calendar Agent Workflow

This repository uses a plan-first, verification-first agent workflow adapted from
the article "바이브 코딩 중인 내가 쓰는 Agent Skills - 260611"
(https://mekain80.tistory.com/323).

## Default Rule

Before changing product code, decide what will be built, where the boundary is,
how it will be tested, and what counts as done.

For code changes, use test-driven development unless the change is pure
documentation, configuration, generated output, or the user explicitly asks for a
throwaway prototype.

## Work Sizing

Classify every task before implementation.

- Small: One file or one module, no API/schema/IPC boundary change.
  Use a short plan in the chat, write the narrow failing test first, implement,
  then run the narrow verification command.
- Medium: One subsystem may touch several files, but contracts stay mostly
  local.
  Create or update a plan under `docs/plans/`, then implement against the plan.
- Large: Work crosses backend, Electron, React, DB, Railway, widget, or local LLM
  boundaries.
  Create a full plan before product-code edits. Include acceptance gates and a
  rollback or fallback story.
- Boundary: Any API route, response schema, preload API, DB migration, source
  type, embedding contract, auth contract, or persisted data meaning changes.
  Treat as Large even when the code diff is small.

## Agent Calendar Boundaries

Use these boundaries when reviewing plans:

- Backend gateway: `apps/backend/app/railway-gateway-server.js`,
  `apps/backend/app/lib/**`, `apps/backend/app/db/**`
- Desktop app: `apps/desktop/src/**`
- Electron bridge and local services: `apps/desktop/electron/**`
- Contracts and tests: `apps/backend/tests/**`, `apps/desktop/tests/**`
- Specs and plans: `docs/**`, `apps/desktop/docs/**`
- Widget integration: `apps/widget/**`

If a task crosses two or more of these, make a plan first.

## Plan Requirements

Medium, Large, and Boundary work needs a markdown plan. Prefer:

`docs/plans/YYYY-MM-DD-short-name.md`

Each plan must include:

- Goal
- Non-goals
- Work size
- Touched boundaries
- Success criteria
- Edge cases
- Test plan
- Acceptance gates
- Step-by-step checklist
- Remaining risks

Use `docs/templates/agent-plan-template.md` as the starting point.

## Implementation Loop

For each behavioral step:

1. Write the failing test first.
2. Run the narrow test and confirm it fails for the expected reason.
3. Write the smallest implementation that passes.
4. Run the same test and confirm it passes.
5. Refactor only while tests stay green.
6. Move to the next checklist item.

Do not broaden scope without updating the plan.

## Verification Gates

Choose the smallest relevant gate first, then broaden before completion.

- Backend syntax: `npm run backend:check`
- Backend tests: `npm run test:backend`
- Desktop typecheck: `npm run typecheck`
- Desktop tests: `npm --workspace apps/desktop run test`
- Desktop build: `npm run build:desktop`
- Full test suite: `npm test`

For boundary changes, include both sides of the boundary. For UI workflow
changes, run the relevant Playwright script under `apps/desktop/tests/`.

## Completion Report

Final reports should include:

- What changed
- Which plan/checklist item was completed
- Verification commands and results
- Any checks not run, with reasons
- Remaining risks or follow-up work
