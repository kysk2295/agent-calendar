# Provider-native Agent Session Bridge Evidence

- Captured: 2026-07-25
- Scope: Agent directory, Runner-local provider catalog, provider session continuity,
  Work Conversation durability, Unified Calendar, Workspace isolation
- Result: REGRESSION PASS ONLY — final completion evidence withdrawn

## Strict provider identity preflight correction

The two-account live harness now verifies both the canonical provider home and an in-memory
digest of the local Codex account identity before starting either Runner/provider journey.
It returns only booleans on success and uses generic error messages on failure; raw account id,
email, token, cookie, credential content, and provider-home paths are not written to evidence.

Verification:

- `node --test apps/desktop/tests/provider-home-identity.test.mjs`
  - distinct account identities accepted;
  - duplicate account identity rejected;
  - same canonical home rejected;
  - unverifiable/API-key-only identity rejected;
  - assertion messages contain no fixture account or credential material.
- Actual strict ETE preflight with the two authenticated Codex homes available on this host:
  - expected rejection: `PROVIDER_IDENTITIES_NOT_DISTINCT`;
  - rejection occurred before Runner/provider work began;
  - both files were distinct, but the private identity comparison showed the same provider
    account;
  - no raw identity or credential material was emitted.

This closes the false-positive release-gate defect. It does not close the release gate itself:
two independently authenticated provider accounts and production WorkOS clean-account login are
still unavailable in this environment.

## Completion-evidence correction

This run remains useful regression evidence, but it is not final proof of the product contract.
Both logical Runners could read the same host-default `CODEX_HOME`, and a newly created provider
session id was persisted only at terminal completion. It therefore did not prove per-user local
provider identity isolation or session continuity across a disconnect immediately after the
provider accepted a turn.

The reopened plan
`docs/plans/2026-07-25-provider-native-agent-session-bridge.md` owns the corrective TDD and a new
separately-homed Runner ETE. Until that gate passes, the agent feature must not be described as
complete.

## Contract observed

- 에이전트마다 기본 Execution Engine과 same-Workspace Runner를 별도로 지정한다.
- Codex/Claude/Hermes agent catalog와 Codex/Claude/Hermes/Grok session catalog는
  사용자의 명시적 동의 뒤 Runner 로컬 connector에서만 읽는다.
- Gateway에는 provider credential, cookie, token, 로컬 원문 설정을 저장하지 않고
  external id와 allowlist된 공개 metadata만 저장한다.
- Work Conversation 하나는 provider external session 하나와 1:1로 연결된다.
- 후속 지시는 저장된 동일 external session id로 전달되고, 실패 시 몰래 새 session을
  만들지 않는다.
- 채팅, plan/checkpoint, 오류, artifact, 결과, 수정 차수, Calendar projection은
  durable storage에서 재시작 뒤 복구된다.
- provider session의 missing/deleted/auth required/quota exhausted 상태를 서로
  구분한다.
- Unified Calendar는 agent work의 예정, 진행, 완료, 재작업, 실패 상태를 표시한다.

## Automated verification

- `npm test`
  - Backend: 498/498 pass.
  - Desktop: 274/274 pass.
  - Runner: 41/41 pass.
- `node --test apps/runner/tests/provider-connectors.test.cjs`
  - 9/9 pass.
  - 잘못된 Claude 파일 하나가 유효한 catalog 전체를 막지 않음.
  - Hermes 표 머리글을 agent로 가져오지 않음.
- `node --test apps/backend/tests/phase10-route-lifecycle.test.cjs`
  - 9/9 pass.
  - 신규 provider agent/session route 7개가 stable control-plane으로 분류됨.
- `npm run backend:check`
  - pass.
- `npm run runner:check`
  - pass.
- `npm run typecheck`
  - pass.
- `npm run build:desktop`
  - pass.

## Actual Electron two-account Codex ETE

Command:

`AGENT_CALENDAR_E2E_TWO_ACCOUNT=1 AGENT_CALENDAR_E2E_LIVE_ENGINE=codex AGENT_CALENDAR_E2E_TIMEOUT_MS=900000 node apps/desktop/tests/playwright-phase3-golden-ete.cjs`

Observed result:

- Result: `ok: true`.
- Duration: 241,750 ms.
- Clean AuthKit login completions: 2.
- Distinct WorkOS subjects and Workspaces: 2 each.
- Runners: exactly 1 per Workspace.
- Both Runners reported authenticated Codex capability.
- Existing Codex agent catalog was read through each account's Runner and one agent was imported.
- Existing Codex session was imported and continued in Agent Calendar.
- Follow-up messages used the same external provider session id.
- Streaming checkpoint and `codex-result.txt` artifact were observed.
- Session rename, search, archive, new session, and existing session resume were exercised.
- Electron restart restored the same Work Conversation, provider session mapping, artifact,
  and Calendar result without another login.
- Completed durable jobs: 4 per Workspace.
- Completed inference jobs: 2 per Workspace.
- Calendar agent-work events: 2 per Workspace.
- Cross-Workspace agent, session, work, artifact, Calendar, and Runner ownership matches: 0.

## Manual surface evidence

- Account A continued provider session:
  `apps/desktop/test-results/phase3-golden-ete-codex/08-workspace-a-provider-session.png`
- Account B clean Workspace:
  `apps/desktop/test-results/phase3-golden-ete-codex/04-workspace-b-clean.png`
- Account B continued provider session:
  `apps/desktop/test-results/phase3-golden-ete-codex/09-workspace-b-provider-session.png`
- Account A provider session after restart:
  `apps/desktop/test-results/phase3-golden-ete-codex/10-workspace-a-provider-rehydrated.png`
- Account B provider session after restart:
  `apps/desktop/test-results/phase3-golden-ete-codex/11-workspace-b-provider-rehydrated.png`

All 11 required two-account screenshots had unique SHA-256 hashes. Manual inspection confirmed
the Argo-inspired agent/session rail, central Work Conversation, streaming checkpoints,
artifact presentation, Account B clean state, and both accounts' restart recovery.

## Honest scope boundary

- Existing provider transcript before import is not copied into Agent Calendar. Agent Calendar
  durably owns the Work Conversation from the import checkpoint forward.
- The live success matrix in this evidence used Codex. Claude/Hermes/Grok adapter contracts and
  failure states are automated; live success for those engines still requires their credentials
  on a user's own Runner.
- No production Railway deployment was performed by this implementation slice.
- Mobile was not started.
