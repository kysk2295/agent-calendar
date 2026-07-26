# Orca flat workbench visual evidence

- Date: 2026-07-25
- Scope: Desktop login, first-run guide, settings
- Result: Pass

## Observed surfaces

### Login

- Capture:
  `apps/desktop/test-results/orca-shell-calendar/login-before-auth.png`
- The authentication boundary is a single 320px borderless entry.
- No split splash, orbit decoration, nested card, gradient, or elevated shadow remains.

### Settings

- Captures:
  - `apps/desktop/test-results/orca-shell-calendar/03-settings.png`
  - `apps/desktop/test-results/orca-shell-calendar/04-settings-768.png`
- The account panel is a flat row between separators rather than a rounded card.
- The section heading renders at 15px and the content stays within the 760px
  reading width without horizontal overflow.

### First-run guide

- Light captures:
  - `apps/desktop/test-results/phase8-session-truth/02-first-run-guide.png`
  - `apps/desktop/test-results/phase8-session-truth/02b-first-run-guide-768.png`
- Dark captures:
  - `apps/desktop/test-results/phase8-session-truth-dark/02-first-run-guide.png`
  - `apps/desktop/test-results/phase8-session-truth-dark/02b-first-run-guide-768.png`
- The global sidebar and top bar remain visible.
- Four setup steps render in a compact workspace rail with one detail pane.
- The guide fills the available content surface, uses no decorative elevation,
  and has no horizontal overflow at either viewport.

## Verification

- Focused design and readiness contracts:
  `node --test apps/desktop/tests/orca-authentic-density.test.mjs apps/desktop/tests/orca-product-surfaces-design.test.mjs apps/desktop/tests/orca-quiet-desktop-design.test.mjs apps/desktop/tests/onboarding-readiness.test.mjs`
  - 25 passed, 0 failed.
- `npm run typecheck`
  - Passed.
- `npm --workspace apps/desktop run test`
  - 260 passed, 0 failed.
- `npm run build:desktop`
  - Passed.
- `node apps/desktop/tests/playwright-orca-shell-calendar.cjs`
  - Passed, including authentication, settings, Calendar, restart restore, and
    encrypted session persistence.
- `node apps/desktop/tests/playwright-phase8-session-truth.cjs`
  - Passed in the light theme.
- `AGENT_CALENDAR_E2E_THEME=dark node apps/desktop/tests/playwright-phase8-session-truth.cjs`
  - Passed in the dark theme.
- `git diff --check`
  - Passed.

## Known unrelated issue

Before this visual pass, `playwright-agent-work-workspace.cjs` failed because its
focusable-control assertion expected an empty list while the current Control Home
contains real controls. The failure was reproduced before product edits and was
not changed or weakened in this pass.
