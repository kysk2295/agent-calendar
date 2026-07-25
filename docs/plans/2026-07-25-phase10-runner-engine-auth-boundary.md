# Plan: Per-Workspace Runner engine authentication boundary

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified

## Goal

사용자가 Agent Calendar 로그인, Google Calendar OAuth, Runner의 실행 엔진 인증을 서로
다른 사용자 소유 경계로 명확히 이해하고 설정할 수 있게 한다. Backend는 설치되었거나
`available`이라고만 보고된 엔진을 인증 완료로 간주하지 않고, 명시적으로 검증된
Runner-hosted 인증만 작업 실행과 온보딩 준비 상태에 사용한다.

## Non-Goals

- Agent Calendar가 Codex, Claude, Grok, Hermes의 provider token을 수집하거나 저장하지 않는다.
- 각 provider의 OAuth 화면을 Agent Calendar 안에 임베드하지 않는다.
- 실제 WorkOS tenant나 provider 계정에 로그인하는 외부 변경을 수행하지 않는다.
- 한 번에 네 엔진을 모두 인증해야만 제품을 사용할 수 있도록 강제하지 않는다.

## Touched Boundaries

- Backend gateway: 없음
- Backend library: Runner capability 정규화, 연결 테스트, durable engine 선택
- DB/migrations: 없음
- Electron bridge: 없음
- React UI: 온보딩 Runner 단계와 Runner engine 인증 상태
- Tests: Backend auth fail-closed 계약, Desktop readiness/presentation, 실제 Runner ETE
- Docs: 이 계획과 운영 증거

## Success Criteria

- [x] `available`이지만 인증 상태가 `missing`/`unknown`인 엔진은 실행 대상으로 선택되지 않는다.
- [x] 연결된 Runner에 인증 엔진이 없으면 연결 테스트와 온보딩이 준비 완료를 표시하지 않는다.
- [x] Runner 설정에서 엔진별 설치·인증 상태와 host-side 로그인 안내가 보인다.
- [x] 온보딩이 서비스 로그인, Calendar OAuth, Runner provider 인증의 경계를 설명한다.
- [x] 최소 한 개의 명시적으로 인증된 엔진이 있으면 기존 실행 경로가 유지된다.

## Edge Cases

- 과거 Runner가 `authStatus`를 보내지 않음: 인증 미확인으로 fail closed 한다.
- Test Fake Engine: `authStatus: ok`만 테스트 환경에서 인증 완료로 인정한다.
- 엔진 설치됨/로그인 안 됨: 설치 정보와 버전은 보이되 실행 준비는 거부한다.
- Runner 연결 끊김: 과거 인증 결과가 있어도 현재 준비 완료를 표시하지 않는다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] Backend engine selection과 capability 정규화가 미인증 `available` 보고를 거부
  - [x] Desktop onboarding이 연결됨/미인증 상태를 `실행 엔진 인증 필요`로 표시
  - [x] Desktop engine presentation이 인증 상태를 별도 사용자 문구로 제공
- GREEN:
  - [x] 공통 Backend 인증 판정으로 normalize/test/resolve 경로를 fail closed
  - [x] 온보딩과 Runner Setup이 같은 인증 의미를 표시
- REFACTOR:
  - [x] 중복 조건을 최소한의 순수 helper로 모은다.

## Acceptance Gates

- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`

건너뛴 gate:

- Gate: 없음
  - Reason: 실행 자격과 사용자 표시를 동시에 바꾸는 보안·제품 경계다.

## Implementation Checklist

- [x] Step 1: Backend와 Desktop RED 계약을 고정한다.
- [x] Step 2: Backend capability 정규화·연결 테스트·engine 선택을 인증 fail closed로 바꾼다.
- [x] Step 3: 온보딩과 Runner Setup에 세 인증 경계와 engine별 상태를 표시한다.
- [x] Step 4: 실제 Runner enrollment ETE에서 인증 상태와 준비 완료를 확인한다.
- [x] Step 5: 전체 회귀와 운영 증거를 갱신한다.

## Verification Notes

- Command: `node --test apps/backend/tests/phase10-runner-engine-auth-boundary.test.cjs`
  - Result: RED 0/2에서 GREEN 2/2. 미인증 `available` 엔진 선택과 정규화를 fail closed로 고정.
- Command: `node --test apps/desktop/tests/onboarding-readiness.test.mjs apps/desktop/tests/runner-engine-auth-presentation.test.mjs`
  - Result: PASS 6/6.
- Command: `node apps/desktop/tests/playwright-phase2-runner-enrollment-e2e.cjs`
  - Result: PASS 13.7s. AuthKit, 인증 경계, QR/지문 등록, capability, 연결 테스트,
    disconnect/reconnect, credential rotation, revoke를 실제 Electron/Runner에서 확인.
- Command: `npm run backend:check && npm run typecheck`
  - Result: PASS.
- Command: `npm test`
  - Result: PASS — Backend 460, Desktop 262, Runner 29.
- Command: `git diff --check`
  - Result: PASS.

## Remaining Risks

- Risk: 오래된 Runner는 새 인증 상태 계약을 충족하지 않아 재로그인/업데이트 안내가 필요할 수 있다.
  - Mitigation: 실행을 추측하지 않고 `인증 확인 필요`로 표시하며 기존 Runner 업데이트 경로를 사용한다.
- Risk: 실제 provider OAuth/CLI 로그인의 공급자별 성공은 로컬 fake capability로 대체했다.
  - Mitigation: 공개 RC 전에 실제 Codex·Claude·Grok·Hermes 계정별 smoke와 외부 tenant
    staging gate를 수행한다.
