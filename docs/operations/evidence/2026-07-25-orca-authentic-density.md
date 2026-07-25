# Orca-authentic Desktop density evidence

- Date: 2026-07-25
- Scope: Desktop shell, first-run guide, Agent Work Control Home
- Result: Pass

## Reference observations

Official Orca screenshots and source were used as a structural reference:

- compact 13px navigation rows and neutral active surfaces
- a short progress-bar group in onboarding
- one visual frame around primary task entry
- flat work rows and a narrow secondary execution rail

Agent Calendar kept its own information architecture, name, logo, calendar semantics,
and terracotta accent.

## TDD evidence

RED:

```text
node --test apps/desktop/tests/orca-authentic-density.test.mjs
4 failed, 0 passed
```

The failures identified the former 24px chrome logo, full-width onboarding rail,
double-framed delegation input, and forced 44px desktop controls.

GREEN:

```text
node --test \
  apps/desktop/tests/orca-authentic-density.test.mjs \
  apps/desktop/tests/orca-product-surfaces-design.test.mjs \
  apps/desktop/tests/orca-quiet-desktop-design.test.mjs \
  apps/desktop/tests/orca-shell-calendar-design.test.mjs \
  apps/desktop/tests/agent-work-design-system.test.mjs
34 passed, 0 failed
```

## Automated gates

```text
npm run typecheck
passed

npm --workspace apps/desktop run test
255 passed, 0 failed

npm run build:desktop
passed

node --check apps/desktop/tests/playwright-agent-work-workspace.cjs
passed

git diff --check -- <changed files>
passed
```

The build retains the pre-existing 596.8 kB renderer chunk warning. No dependency or
JavaScript runtime weight was added by this pass.

## Manual QA

Control Home:

```text
AGENT_CALENDAR_E2E_CONTROL_HOME_ONLY=1 \
EVIDENCE_DIR=apps/desktop/test-results/orca-authentic-density/light \
node apps/desktop/tests/playwright-agent-work-workspace.cjs

AGENT_CALENDAR_E2E_CONTROL_HOME_ONLY=1 \
AGENT_CALENDAR_E2E_THEME=dark \
EVIDENCE_DIR=apps/desktop/test-results/orca-authentic-density/dark \
node apps/desktop/tests/playwright-agent-work-workspace.cjs
```

- Light and dark passed.
- 1280px: primary work area 696px, execution rail 320px.
- 768px and 375px: execution rail stacks below the primary work area.
- Every viewport reported document width equal to viewport width.
- No console errors.

First-run guide:

```text
AGENT_CALENDAR_PHASE8_SESSION_TRUTH=1 \
node apps/desktop/tests/playwright-workos-authkit-login-e2e.cjs

AGENT_CALENDAR_PHASE8_SESSION_TRUTH=1 \
AGENT_CALENDAR_E2E_THEME=dark \
node apps/desktop/tests/playwright-workos-authkit-login-e2e.cjs
```

- Light and dark passed.
- 1320px and 768px captures show the compact four-bar progress group, one current
  setup action, no sidebar, and no nested setup cards.
- safeStorage, stale profile recovery, and restart session restoration remained green.

## Artifacts

- `apps/desktop/test-results/orca-authentic-density/light/desktop-control-home.png`
- `apps/desktop/test-results/orca-authentic-density/light/tablet-control-home.png`
- `apps/desktop/test-results/orca-authentic-density/light/mobile-control-home.png`
- `apps/desktop/test-results/orca-authentic-density/dark/desktop-control-home.png`
- `apps/desktop/test-results/orca-authentic-density/dark/tablet-control-home.png`
- `apps/desktop/test-results/orca-authentic-density/dark/mobile-control-home.png`
- `apps/desktop/test-results/phase8-session-truth/02-first-run-guide.png`
- `apps/desktop/test-results/phase8-session-truth/02b-first-run-guide-768.png`
- `apps/desktop/test-results/phase8-session-truth-dark/02-first-run-guide.png`
- `apps/desktop/test-results/phase8-session-truth-dark/02b-first-run-guide-768.png`

## Residual risk

The main CSS files are still large and carry historical selectors. The new density
contract guards the authoritative selectors, but a future component-system extraction
would reduce maintenance risk further.
