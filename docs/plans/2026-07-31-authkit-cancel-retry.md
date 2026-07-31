# Plan: AuthKit 로그인 취소 후 재시도 복구

- Date: 2026-07-31
- Owner: Codex
- Work size: Large (auth boundary)
- Status: Verified

## Goal

Agent Calendar Desktop에서 AuthKit 로그인을 취소한 직후 다시 시도해도 이전 요청의
비동기 오류가 새 로그인 상태를 덮어쓰지 않게 한다. Backend start 응답과 WorkOS
authorization URL이 같은 OAuth state를 사용하게 하고, 실제 시스템 브라우저의 Google
로그인에서 앱으로 돌아와 인증된 작업공간이 표시되는 것까지 확인한다.

## Non-Goals

- WorkOS 또는 Google의 테넌트/콘솔 설정을 재설계하지 않는다.
- Google Calendar 연결 OAuth를 작업공간 로그인과 합치지 않는다.
- 기존 미커밋 로그인 개선을 되돌리거나 범위를 넓혀 리팩터링하지 않는다.

## Touched Boundaries

- Backend gateway: Phase 1 Desktop auth route 응답 계약
- Backend library: WorkOS AuthKit adapter와 Desktop login transaction
- DB/migrations: 없음
- Electron bridge: 로그인 취소 및 AuthKit 요청 수명주기
- React UI: 취소된 요청과 새 요청의 상태 경합 방지
- Tests: 실제 Electron AuthKit 취소/재시도 회귀 시나리오
- Docs: 이 계획

## Success Criteria

- [x] 로그인 취소 후 즉시 재시도하면 새 AuthKit 요청이 대기 상태로 유지된다.
- [x] 이전 요청의 `이전 로그인 시도가 취소되었습니다` 오류가 새 요청 UI를 덮어쓰지 않는다.
- [x] start payload의 state, 저장된 state hash, WorkOS authorization URL state가 동일하다.
- [x] Google 로그인을 마치면 Agent Calendar 인증 화면이 사라지고 작업공간이 표시된다.

## Edge Cases

- 취소 IPC 응답보다 기존 로그인 Promise 거절이 늦게 도착하는 경우
- 취소 직후 사용자가 즉시 재시도하는 경우
- 오래된 callback/state가 새 로그인 도중 도착하는 경우
- WorkOS SDK가 호출자가 전달한 state 대신 자체 PKCE state를 생성하는 경우

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] Electron E2E에서 로그인 시작 → 취소 → 즉시 재시도 후 이전 오류가 노출되지 않고 두 번째 transaction이 생성되는지 검증한다.
  - [x] Backend integration에서 SDK 생성 state와 호출자 요청 state가 다를 때 URL의 state가 API payload와 transaction에 사용되는지 검증한다.
- GREEN:
  - [x] 요청 세대를 구분해 현재 로그인 시도만 React 상태를 갱신하게 한다.
- REFACTOR:
  - [x] 중복 상태 전이를 최소화하되 로그인/세션 계약은 변경하지 않는다.

## Acceptance Gates

- [x] `npm run typecheck`
- [x] `npm run backend:check`
- [x] `node --test apps/backend/tests/workos-authkit-adapter.test.cjs`
- [x] `node --test apps/backend/tests/phase1-workos-desktop-login.test.cjs`
- [ ] `npm --workspace apps/desktop run test`
- [x] 좁은 Electron AuthKit 취소/재시도 E2E
- [x] 실제 Electron + 시스템 브라우저 Google 로그인 수동 QA

건너뛴 gate:

- Gate: `npm test`
  - Reason: Desktop 전체 suite가 변경 범위 밖 기존 `AgentWorkWorkspace.tsx`의 “목표만으로 위임” 문구 계약 1건으로 실패한다.
- Gate: `npm --workspace apps/desktop run test`
  - Reason: 2026-07-31 재실행에서 변경된 login/widget 계약은 통과했으나 위 기존 문구 계약 1건이 남는다.
- Gate: `npm run build:desktop`
  - Reason: typecheck와 Desktop test가 Electron 빌드를 포함하며, 제품 표면은 dev Electron에서 별도 검증한다.

## Implementation Checklist

- [x] 취소/재시도 경합을 자동화된 Electron 테스트로 재현한다.
- [x] 현재 로그인 요청만 UI 상태를 갱신하도록 최소 수정한다.
- [x] WorkOS SDK가 생성한 state를 adapter와 Desktop start 계약 전체에서 사용한다.
- [x] 테스트·타입체크 후 dev Electron을 재시작한다.
- [x] Google 로그인과 앱 복귀를 실제 UI에서 확인한다.

## Verification Notes

- Command: Orca UI에서 로그인 취소 → 재시도
  - Result: 재현됨. 새 브라우저 화면 대신 `Error invoking remote method 'auth:authkit-login': Error: 이전 로그인 시도가 취소되었습니다.`가 반복 표시된다.
- Command: `node --test apps/backend/tests/workos-authkit-adapter.test.cjs apps/backend/tests/phase1-workos-desktop-login.test.cjs`
  - Result: 7/7 통과. URL state, API payload, 저장 hash가 같은 SDK 생성 state를 사용한다.
- Command: `npm run backend:check` / `npm run typecheck`
  - Result: 통과.
- Command: Electron AuthKit E2E
  - Result: 취소 후 재시도, 로그인 완료, 암호화 세션, 재시작 복원 통과.
- Command: Railway production `/api/phase1/auth/desktop/start`
  - Result: WorkOS 설정 적용 및 authorization URL state 일치 확인.

## Remaining Risks

- Risk: 실제 WorkOS/Google 계정 선택 단계는 외부 브라우저와 로컬 custom protocol 등록 상태에 영향을 받는다.
  - Mitigation: 자동화 테스트 외에 실행 중인 Electron과 Chrome에서 직접 완료한다.
- Risk: Railway 직접 배포는 Git 이력에 남지 않아 이후 GitHub 자동 배포가 덮어쓸 수 있다.
  - Mitigation: 이 검증된 변경을 현재 브랜치에 커밋·푸시한다.
