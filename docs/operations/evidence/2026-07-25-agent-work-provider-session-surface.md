# Agent Work provider-session surface evidence

- Date: 2026-07-25
- Scope: Desktop Agent Work presentation only
- Plan: `docs/plans/2026-07-25-agent-work-provider-session-surface.md`

## Observed Surface

- Light desktop:
  `apps/desktop/test-results/agent-provider-session-redesign-light/desktop-work-conversation.png`
- Light compact:
  `apps/desktop/test-results/agent-provider-session-redesign-light/mobile-work-conversation-bottom.png`
- Dark desktop:
  `apps/desktop/test-results/agent-provider-session-redesign-dark/desktop-work-conversation.png`

The live renderer fixture contains a user request, approval, plan, assistant response, progress,
blocker, result, artifact actions, task inspector, and composer. The observed surface showed:

- no page-level horizontal overflow;
- assistant prose without a surrounding card;
- compact plan and progress activity on one execution rail;
- decisions and results retaining their valid actions;
- a single-frame composer that remains reachable at the bottom;
- actual resolved engine `Codex` in the session header;
- the same hierarchy in light and dark themes;
- 375px reflow with the inspector following the conversation.

## Verification

- Focused RED to GREEN:
  - `node --test apps/desktop/tests/agent-work-provider-session-surface.test.mjs apps/desktop/tests/agent-work-design-system.test.mjs apps/desktop/tests/agent-work-conversation.test.mjs apps/desktop/tests/provider-agent-session-ux.test.mjs`
  - Result: 33 pass, 0 fail
- Desktop suite:
  - `npm --workspace apps/desktop run test`
  - Result: 281 pass, 0 fail
- Desktop production build:
  - `npm run build:desktop`
  - Result: pass
- Light renderer surface:
  - `AGENT_CALENDAR_E2E_CONVERSATION_SURFACE_ONLY=1 ... playwright-agent-work-workspace.cjs`
  - Result: 5 surface checks pass
- Dark renderer surface:
  - `AGENT_CALENDAR_E2E_CONVERSATION_SURFACE_ONLY=1 AGENT_CALENDAR_E2E_THEME=dark ... playwright-agent-work-workspace.cjs`
  - Result: 5 surface checks pass

## Known Non-blocking Output

- Desktop unit execution printed that Vite HMR port `24678` was already in use. The suite still
  completed 281/281 and the production build passed.
- Vite reported the existing renderer chunk-size warning. This redesign did not add a dependency
  or increase the application architecture boundary.
