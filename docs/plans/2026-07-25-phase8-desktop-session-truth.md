# Plan: Phase 8 Desktop Session Truth and First-run Guide

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified slice; Phase 8 release-candidate work remains open
- Parent: `docs/plans/2026-07-24-production-development-roadmap.md`

## Goal

Desktop이 공개 프로필 메타데이터를 실제 로그인 세션으로 오인하지 않게 한다. 암호화된
세션이 없거나 복구할 수 없으면 로그인 화면으로 안전하게 돌아가며, 로그인 전에는
Workspace 제품 데이터를 요청하지 않는다. 정상 로그인 후에는 캘린더, Runner와 실행
엔진, Wiki, Calendar AI를 실제 제품 상태에 맞춰 준비하는 첫 실행 가이드를 제공한다.

## Non-Goals

- Phase 8의 첫 실행 이후 전체 UI 마이그레이션
- WorkOS 실계정과 운영 Dashboard 설정
- 코드 서명, notarization, 자동 업데이트
- Web, 운영 안정화, Mobile

## Work Size

인증·세션 진실성과 Electron→React 경계를 변경하므로 Large / Boundary다.

## Touched Boundaries

- Electron session/settings: `apps/desktop/electron/main.ts`,
  `apps/desktop/electron/settings.ts`
- React auth/hydration and onboarding: `apps/desktop/src/App.tsx`,
  `apps/desktop/src/features/onboarding/**`
- Tests: `apps/desktop/tests/playwright-phase8-session-truth.cjs`,
  existing WorkOS AuthKit and Desktop contract suites
- Docs/evidence: this plan and Phase 8 evidence JSON

## Success Criteria

- [x] 공개 AuthKit 프로필만 있고 암호화된 세션이 없으면 로그인 화면이 보이고 공개
      프로필은 정리된다.
- [x] 로그인 전에는 보호된 `/api/*` 제품 요청이 발생하지 않는다.
- [x] 정상 AuthKit 로그인은 한 번만 완료되고 암호화 세션으로 재시작 후 복원된다.
- [x] settings와 renderer에는 access/refresh/API token이 노출되지 않는다.
- [x] 첫 Workspace 로그인은 캘린더 동기화, Runner와 실행 엔진, Wiki 지식 소스,
      Calendar AI 확인 순서의 가이드를 연다.
- [x] 각 가이드 단계는 실제 Workspace 소스와 Runner 상태로 완료 여부를 계산하며 실제
      설정 표면 또는 동작으로 연결된다.
- [x] 완료 또는 나중에 하기는 Workspace 설정에 저장되고 재시작 후 복원되며, 설정에서
      가이드를 다시 열 수 있다.
- [x] 기존 Desktop 인증·타입·빌드 계약이 회귀하지 않는다.

## Edge Cases

- 설정 파일에는 공개 프로필이 있지만 `app-session.enc`가 없음
- 암호화 저장소가 세션을 복호화하지 못함
- 정상 세션은 존재하지만 access token이 만료되어 refresh가 필요함
- 로그아웃 직후 renderer가 이전 Workspace hydration을 재시도함
- 캘린더, Runner, Wiki가 모두 비어 있거나 일부만 준비됨
- 가이드를 나중에 하기로 닫은 뒤 다른 Workspace로 로그인함

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] stale profile/no encrypted session Electron ETE가 로그인 버튼 부재 또는 보호 API
        호출로 실패하는 것을 확인한다.
  - [x] session truth가 GREEN인 production build에서 첫 로그인 가이드가 없어서 Electron
        ETE가 실패하는 것을 확인한다.
- GREEN:
  - [x] 명시적 secure-session 상태만 production 로그인 진실로 사용한다.
  - [x] signed-out boot에서 제품 hydrate를 건너뛰고 orphan profile을 제거한다.
  - [x] 실제 소스 상태와 Workspace settings에 기반한 가이드 화면을 구현한다.
- REFACTOR:
  - [x] 테스트 harness의 명시적 legacy preview 호환만 유지하고 production fallback은
        만들지 않는다.

## Manual QA Scenarios

1. `node apps/desktop/tests/playwright-phase8-session-truth.cjs`
   - 입력: stale AuthKit profile + missing `app-session.enc`
   - PASS: 로그인 버튼 표시, stale profile 제거, 보호 API 사전 호출 0
   - 증거: `apps/desktop/test-results/phase8-session-truth/01-stale-profile-login.png`
2. 같은 ETE에서 AuthKit callback을 한 번 완료하고 Electron을 재시작한다.
   - PASS: 첫 실행 가이드 표시, 캘린더/Runner/Wiki/Calendar AI 단계 표시,
     `나중에 하기` 저장, `completeCount=1`, 재로그인 버튼 없음, Calendar 표시, 암호화
     세션 파일 내 평문 토큰 없음, 설정 팝업에서 가이드 재진입
   - 증거: `02-first-run-guide.png`, `03-authenticated-calendar.png`,
     `04-restarted-calendar.png`, evidence JSON

## Acceptance Gates

- [x] Phase 8 Electron ETE
- [x] Existing WorkOS AuthKit Electron ETE
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm test`
- [x] Manual screenshot QA
- [x] No orphan Electron/server/temp user-data

건너뛴 gate:

- LSP diagnostics:
  - Reason: Biome language server is unavailable in this workspace and installation was previously
    declined; TypeScript typecheck is the blocking substitute.

## Implementation Checklist

- [x] Add stale-profile failing Electron scenario.
- [x] Correct public settings session truth.
- [x] Prevent signed-out protected hydration.
- [x] Preserve valid secure-session restart behavior.
- [x] Add readiness-derived first-run guide and Workspace-scoped completion.
- [x] Add Settings re-entry and guide-return affordance.
- [x] Record screenshots, evidence, cleanup, and verification.

## Rollback and Fallback

- Revert this slice to the previous signed Desktop build.
- AuthKit remains the only production login path; no shared bearer fallback is introduced.
- If secure session recovery fails, require re-login rather than accepting public profile metadata.

## Verification Notes

- Phase 8 Electron ETE: stale profile recovery, protected requests before login `0`, guide
  `0/4`, Workspace-scoped `dismissed`, Calendar transition, encrypted restart restore,
  `completeCount=1`, Settings re-entry all GREEN.
- Existing AuthKit Electron ETE: GREEN with guide pre-completed in the fixture.
- Targeted tests: secure session + onboarding readiness 7/7; real PostgreSQL cutover 3/3.
- Backend: syntax GREEN; 410/410 tests GREEN.
- Desktop: typecheck/build GREEN; 190/190 tests GREEN.
- Runner: 19/19 tests GREEN through `npm test`.
- Manual QA: the four Phase 8 screenshots have no clipped controls, overlapping guide content,
  false-ready states, or stale profile presentation.
- Evidence: `docs/operations/evidence/2026-07-25-phase8-desktop-session-truth.json`.

## Remaining Risks

- Live WorkOS cloud credentials and signed release candidate remain external Phase 8 gates.
- Live account switching between two simultaneously available Workspace memberships is not yet an
  exposed Desktop flow. Logout clears renderer Workspace state; live multi-Workspace switching
  remains a later Phase 8 story.
