# Plan: First-user journey dogfood (AuthKit/Google → setup → first use)

- Date: 2026-07-31
- Work size: Large / Boundary
- Status: Verified (injected AuthKit ETE; live WorkOS tenant still external)
- Branch: `kysk2295/agent-control-p0-wave1`

## Goal

Prove and harden the **first user path** end-to-end:

1. Desktop boots signed-out
2. AuthKit login (product hosts Google + email magic link; not a separate in-app Google password form)
3. First-run onboarding (Google Calendar → Runner → Wiki → Calendar AI)
4. Reach Control Home / Agent Work with Mode A/B controls

Because Railway/local currently have **no WorkOS secrets**, the automated dogfood uses an **injected AuthKit backend** (same contract as production start/complete). Real Google/AuthKit tenant remains an external gate.

## Non-Goals

- Claiming live WorkOS tenant success without credentials
- Public multi-tenant signup
- Fake production auth when WorkOS is configured

## Success Criteria

- [x] Login UI copy clearly separates workspace AuthKit login vs later Google Calendar OAuth
- [x] Missing WorkOS surfaces actionable Korean error (not opaque failure)
- [x] Playwright first-user journey: login → onboarding → Google connect/sync → agents Mode A/B visible
- [x] Screenshots under `apps/desktop/test-results/first-user-journey/`
- [x] Document remaining real-tenant gates

## Verification

```bash
npm run build:desktop
node --test apps/desktop/tests/login-authkit-copy.test.mjs
AGENT_CALENDAR_E2E_TIMEOUT_MS=120000 node apps/desktop/tests/playwright-first-user-journey.cjs
```

Result: `ok: true`, `completeCount: 1`, `googleCalendarOAuth: true`, restart restore ok.

## External gates (honest)

- `WORKOS_API_KEY` + `WORKOS_CLIENT_ID` + AuthKit Google connection for live Google account login
- Google Calendar OAuth client for real calendar connect
- Workspace Runner enrollment for real agent execution
- Local `POST /api/phase1/auth/desktop/start` currently returns `WORKOS_CONFIG_MISSING` without secrets
