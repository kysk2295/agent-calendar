# Plan: First-user journey dogfood (AuthKit/Google → setup → first use)

- Date: 2026-07-31
- Work size: Large / Boundary
- Status: Verified (injected AuthKit ETE + live empty-state login after OAuth state fix)
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
- Local WorkOS secrets live in gitignored `.env.workos.local` for dogfood

## 2026-07-31 empty-state / second-account follow-up

### Findings

1. **OAuth state mismatch (P0, fixed):** WorkOS SDK generates `state` inside the authorize URL.
   Returning a different `state` in the JSON body caused every live callback to fail as
   `AUTH_STATE_MISMATCH_STALE` / infinite login wait. Canonical state is now the URL query value.
2. **Silent SSO (improved):** default `prompt=login` + Google `select_account` so account chooser
   appears for empty-state / second-account dogfood.
3. **Protocol contention (mitigated earlier):** bare Electron under `Documents/agent-calendar` can
   steal `agent-calendar://` — keep only escolar Electron running for dogfood.
4. **Injected first-user ETE:** still green (`completeCount: 1`, Google OAuth path, restart restore).
5. **Live empty-state:** session clear → AuthKit → start guide **0/4** (Calendar / Runner / Wiki /
   Calendar AI) confirmed for the primary Google account. Second account selection still needs a
   human password step when Google requires re-auth for the secondary account.

### Next product work (empty workspace)

- [x] Google Calendar connect on empty guide — `docs/plans/2026-07-31-empty-guide-google-calendar.md`
- [x] Runner enrollment on empty guide — `docs/plans/2026-07-31-empty-workspace-runner-agent-ux.md`
- [x] Wiki source bind — `docs/plans/2026-07-31-empty-workspace-wiki-onboarding.md` (merged readiness truth)
- [x] Soften false “Railway API 확인 필요” — `docs/plans/2026-07-31-local-gateway-banner.md`
- [x] Calendar AI guide truth — `docs/plans/2026-07-31-empty-guide-calendar-ai.md`

### Orchestration note (2026-07-31)

Run `run_caca919e3de0` supervised five Codex tasks (banner, calendar, runner/agents, wiki, calendar AI). All reported `worker_done` succeeded. Residual: live Google Cloud OAuth consent, physical Runner QR enrollment, and manual Electron first-run on a quiet host.
