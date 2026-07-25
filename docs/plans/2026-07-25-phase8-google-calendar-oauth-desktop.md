# Plan: Phase 8 Production Google Calendar OAuth on Desktop

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: Completed
- Parent: `docs/plans/2026-07-24-production-development-roadmap.md`
- Depends on: `docs/plans/2026-07-24-phase4-unified-calendar-google.md`,
  `docs/plans/2026-07-25-phase8-desktop-session-truth.md`

## Goal

Desktop과 첫 실행 가이드에서 테스트용 Google 연결을 제거하고 실제 Google Calendar OAuth
브라우저 왕복을 제공한다. OAuth code/state와 Workspace 세션 토큰은 Electron main과
Backend 경계 밖으로 노출하지 않으며, 연결 직후 동기화된 Google 소스가 Unified
Calendar와 가이드의 실제 완료 상태가 된다.

## Non-Goals

- Google Cloud 운영 자격 증명의 발급 또는 사용자 대신 Console 설정
- Apple Calendar, Outlook Calendar 추가
- Phase 8 전체 설정 정보 구조 개편
- Web 랜딩, 코드 서명·공증, updater
- 기존 Phase 4 provider·vault·watch 구현 재작성

## Work Size

외부 OAuth, secure session, custom-protocol deep link, Electron preload IPC, React UI와 실제
Electron ETE를 함께 변경하므로 Large / Boundary다.

## Touched Boundaries

- Backend gateway: 기존 production Google authorize/callback/sync routes를 ETE에서 사용
- Backend library: 기존 `UnifiedCalendar.startGoogleAuthorize/finalizeGoogleOAuth`
- DB/migrations: 변경 없음; 기존 OAuth state, vault, calendar source tables 사용
- Electron bridge: `apps/desktop/electron/deepLink.ts`,
  `apps/desktop/electron/deepLinkMain.ts`, 신규 Calendar OAuth coordinator,
  `apps/desktop/electron/main.ts`, preload
- React UI: `apps/desktop/src/App.tsx`, Calendar/onboarding connection states
- Tests: deep-link, coordinator, production Electron Google OAuth ETE, existing AuthKit ETE
- Docs/evidence: this plan, roadmap, Phase 8 evidence JSON and screenshots

## Success Criteria

- [x] Desktop `Google Calendar 연결`이 Backend authorize를 현재 암호화 Workspace 세션으로
      호출하고 시스템 브라우저를 연다.
- [x] `agent-calendar://calendar/google/callback`만 Calendar OAuth callback으로
      받아들이며 code/state는 renderer에 전달하지 않는다.
- [x] local pending state와 Backend Workspace/user/state 검증을 모두 통과한 callback만
      한 번 finalize된다.
- [x] 연결 성공 직후 source sync를 수행하고 Calendar와 가이드에 `동기화 완료`가
      실제 `lastSyncedAt`으로 표시된다.
- [x] OAuth 미설정, 잘못된 state, 중복 callback은 fail closed하고 사용자가 복구 가능한
      메시지를 본다.
- [x] production Desktop에는 `Google 연결 (Fake)` 또는 fake-connect 호출이 남지 않는다.
- [x] AuthKit callback, encrypted session restart, Phase 4/8 Calendar 기능이 회귀하지 않는다.

## Edge Cases

- 로그인 세션 없이 connector 시작
- 진행 중인 연결이 있는데 다시 시작
- callback host/path 또는 query key가 변조됨
- callback state가 현재 local pending state와 다름
- callback이 재사용됨
- Backend가 `GOOGLE_OAUTH_NOT_CONFIGURED` 또는 vault/config 503을 반환
- authorize는 성공했지만 browser open이 실패
- finalize는 성공했지만 첫 sync가 실패
- 연결 후 앱 재시작
- AuthKit callback과 Calendar callback이 교차 입력됨

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] strict Calendar deep-link parser가 없어 parser test가 실패한다.
  - [x] secure-session-owned coordinator가 없어 authorize/finalize contract test가 실패한다.
  - [x] production Electron ETE가 `Google Calendar 연결`과 fail-closed message를 찾지
        못해 실패한다.
- GREEN:
  - [x] main-process coordinator, distinct deep link, narrow IPC result를 최소 구현한다.
  - [x] Calendar/onboarding action을 production connector로 교체하고 성공 후 sync한다.
  - [x] ETE fake backend는 실제 route shape와 secure bearer를 검증한다.
- REFACTOR:
  - [x] AuthKit과 Calendar OAuth의 공통 HTTP 유틸은 중복이 실제로 방해될 때만 추출한다.
  - [x] Fake connector는 Backend test-only route로 유지하되 Desktop production surface에서
        제거한다.

## Manual QA Scenarios

1. `node apps/desktop/tests/playwright-phase8-google-calendar-oauth.cjs`
   - 첫 authorize는 503
   - PASS: full-window error screenshot에
     `Google Calendar 연결을 사용할 수 없습니다` 표시, callback/finalize 0
2. 같은 ETE의 retry
   - authorize URL 기록 후 forged-state deep link, then correct deep link
   - PASS: forged callback finalize 0, correct callback finalize 1, source connected,
     sync 1, `lastSyncedAt` 표시
3. 같은 userData hard restart
   - PASS: 로그인 재요청 없이 synchronized Google source와 Unified Calendar 복원
4. existing WorkOS AuthKit ETE
   - PASS: `completeCount=1`, Calendar callback namespace가 AuthKit에 전달되지 않음

## Acceptance Gates

- [x] strict parser + coordinator targeted tests
- [x] production Google OAuth Electron ETE
- [x] existing WorkOS AuthKit Electron ETE
- [x] Phase 4 Unified Calendar Electron ETE
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [x] Manual screenshot QA
- [x] No orphan Electron/server/temp user-data
- [x] `git diff --check`

건너뛴 gate:

- Live Google Cloud OAuth:
  - Reason: client ID/secret, redirect registration, consent screen, and production vault key are
    external credentials. The exact production path is exercised with a faithful fake provider.
- LSP diagnostics:
  - Reason: TypeScript/Biome language servers are unavailable and installation was previously
    declined. Typecheck/build are blocking substitutes.

## Implementation Checklist

- [x] Add strict Calendar callback type/parser/routing.
- [x] Add main-process Google Calendar OAuth coordinator.
- [x] Add secure IPC, preload API, public result.
- [x] Replace renderer Fake action and add pending/error/success states.
- [x] Connect onboarding Calendar action directly to production connector.
- [x] Extend fake backend and production Electron ETE.
- [x] Prove fail-closed, forged state, success, sync, restart, AuthKit regression.
- [x] Record screenshots, evidence, cleanup, and verification.

## Rollback and Fallback

- Disable external Calendar with `UNIFIED_CALENDAR_EXTERNAL_ENABLED=0`.
- Revert Desktop to the preceding signed build; internal Calendar remains usable.
- Never fall back from failed production OAuth to fake-connect or a shared server credential.
- Existing connected sources remain stored and can be disconnected independently.

## Verification Notes

- Targeted parser/coordinator/readiness: 13/13 passed.
- Production Electron Google OAuth ETE passed in light and dark themes.
- AuthKit ETE passed with `completeCount=1` and encrypted restart restore.
- Phase 4 Unified Calendar ETE passed with six unique screenshots, one reconciled create,
  Workspace B source count 0, and cross-workspace sync 404.
- Full gates: Backend 410, Desktop 196, Runner 19.
- Manual QA approved the compact Orca-inspired guide, inline configuration error, synchronized
  success state, and restart source truth in both themes.
- Evidence: `docs/operations/evidence/2026-07-25-phase8-google-calendar-oauth.json`.

## Remaining Risks

- Live Google consent-screen review, redirect URI registration, quota, webhook reachability, and
  token revocation behavior require the production Google project.
- Signing/notarization and custom-protocol registration must be proven on the signed release
  candidate.
- If the user quits the app while the system-browser OAuth attempt is pending, local pending state
  is lost and the connection must be started again. The Backend state remains one-use and scoped.
