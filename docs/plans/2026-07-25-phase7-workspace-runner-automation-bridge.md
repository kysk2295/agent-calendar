# Plan: Phase 7 Workspace Runner automation bridge

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified locally; live installed Hermes release gate remains open

## Goal

프로덕션 Automation Federation의 Hermes 조회·생성·수정·일시정지·재개·즉시 실행을
요청 Workspace에 연결된 Runner에서만 수행한다. Gateway의 전역
`HERMES_RELAY_RUNNER_ID`는 더 이상 다중사용자 자동화 권한으로 사용하지 않고,
Hermes API URL/token은 사용자 Runner 로컬에만 남긴다.

## Non-Goals

- Claude/Codex/Grok에 공개 자동화 API가 있다고 가정하지 않는다. 이번 slice는 실제
  기존 Hermes source를 Runner-native로 전환하고, 다른 provider는 지원 capability가
  생길 때까지 명시적으로 unavailable을 유지한다.
- Mobile 코드를 시작하지 않는다.
- 운영 Runner나 Railway를 원격 변경하지 않는다.

## Touched Boundaries

- Backend gateway: production Automation Adapter composition
- Backend library: Runner automation source Adapter, connector request completion
- DB/migrations: Runner connector request kind 확장
- Electron bridge: 없음
- React UI: 기존 Connected Automation UX 계약 유지
- Runner: local Hermes automation connector와 connector loop
- Tests: Backend real PostgreSQL A/B isolation, Runner connector contract
- Docs: 계획 및 실제 검증 증거

## Success Criteria

- [x] Automation source의 모든 실제 요청은 source에 저장된 same-Workspace `runnerId`로만
      전달된다.
- [x] Runner B는 Workspace A 자동화 요청을 열거·수신·완료할 수 없다.
- [x] Hermes URL/token은 Runner 환경에서만 읽고 Gateway request/DB/response에 저장하지
      않는다.
- [x] list/create/update/pause/resume/run 결과가 기존 Automation Federation receipt와
      Unified Calendar projection에 그대로 연결된다.
- [x] Runner offline, timeout, provider auth/error를 조용한 전역 fallback 없이 정직하게
      반환한다.
- [x] 프로덕션 Gateway는 전역 `HERMES_RELAY_RUNNER_ID` Automation Adapter를 구성하지
      않는다.

## Edge Cases

- Runner가 요청을 가져가기 전에 만료되면 `SOURCE_TIMEOUT`으로 종료한다.
- 다른 Runner가 request ID를 복사해 완료하려 하면 not found로 거부한다.
- Runner local Hermes endpoint는 loopback HTTP(S)만 허용하고 사용자 정보가 포함된 URL은
  거부한다.
- provider 응답에 credential/token/private path가 있으면 Runner와 Gateway 양쪽에서
  영속화 전에 차단한다.
- 동일 automation change request ID 재시도는 기존 receipt를 반환하고 provider를 다시
  실행하지 않는다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

### RED

- [x] 기본 Phase 7 runtime이 same-Workspace Runner connector로 capabilities/list/pause를
      전달하는 real PostgreSQL test.
- [x] Runner B가 A의 요청을 받거나 완료할 수 없는 hostile isolation test.
- [x] Runner connector loop가 automation 요청/result를 처리하고 secret-shaped 응답을
      거부하는 test.
- [x] production composition이 global Hermes relay Automation Adapter를 사용하지 않는 test.

### GREEN

- [x] connector request schema와 service protocol을 automation kind/result로 확장한다.
- [x] Backend Runner Automation Source Adapter를 기본 production Adapter로 연결한다.
- [x] Runner local Hermes HTTP connector를 구현한다.

### REFACTOR

- [x] 기존 Automation Federation/Connected Automation 공개 shape와 approval policy는
      변경하지 않는다.

## Acceptance Gates

- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [x] 실제 local PostgreSQL + 두 Runner connector 표면 QA

건너뛴 gate:

- Gate: live installed Hermes automation
  - Reason: 운영 사용자의 Runner local Hermes endpoint/auth 설정과 외부 실행 승인이 없다.

## Implementation Checklist

- [x] Step 1: RED tests와 migration contract를 추가한다.
- [x] Step 2: Gateway connector queue 및 same-Workspace Adapter를 구현한다.
- [x] Step 3: Runner local Hermes automation connector를 구현한다.
- [x] Step 4: 실제 PostgreSQL A/B lifecycle과 전체 회귀를 검증한다.
- [x] Step 5: 증거를 기록하고 커밋한다.

## Verification Notes

- Command:
  - `node --test apps/runner/tests/provider-connectors.test.cjs`
  - Result: 11/11 passed.
- Command:
  - `node --test apps/backend/tests/phase7-automation-federation.test.cjs`
  - Result: 6/6 passed, including real PostgreSQL Workspace A/B isolation.
- Command:
  - `npm run backend:check && npm --workspace apps/runner run check && npm run typecheck && npm run build:desktop && npm test`
  - Result: checks/build passed; Backend 504/504, Desktop 274/274, Runner 43/43.
- Manual surface:
  - Actual loopback HTTP observed Hermes list and pause requests, local Authorization presence,
    public result projection, and absence of the local token from the returned result.

## Remaining Risks

- Risk: Hermes local API의 배포별 endpoint 계약이 바뀔 수 있다.
  - Mitigation: Runner capability probe와 fail-closed connector 오류를 유지하고 staging의
    실제 설치본 ETE를 별도 릴리스 관문으로 둔다.
- Risk: Claude/Codex/Grok는 Hermes와 동일한 자동화 CRUD API가 없을 수 있다.
  - Mitigation: provider별 capability를 정직하게 노출하고 로컬 공개 계약이 확인되기
    전에는 지원을 발명하지 않는다.
