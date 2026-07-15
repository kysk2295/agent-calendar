# Plan: Backend aggregate test termination repair

- Date: 2026-07-15
- Owner: Codex
- Work size: Medium
- Status: Verified

## Goal

백엔드 전체 테스트가 Codex planning 구간에서 pending Promise로 취소되지 않고 정상 종료되도록 한다. 동일한 `main` 소스에서 백엔드와 monorepo 전체 테스트가 실패·취소 없이 성공 종료해야 한다.

## Non-Goals

- Agent Work, Hermes, Codex 실행 정책이나 사용자 기능을 새로 설계하지 않는다.
- Railway 배포나 운영 자격 증명을 변경하지 않는다.
- 테스트 종료 결함과 무관한 성능·UI 정리를 함께 수행하지 않는다.

## Touched Boundaries

- Backend gateway: 원인이 relay long-poll 또는 planning orchestration이면 해당 최소 경계만 수정
- Backend library: 원인이 execution adapter coordination이면 해당 최소 경계만 수정
- DB/migrations: 없음
- Electron bridge: 없음
- React UI: 없음
- Tests: `apps/backend/tests/agent-operations.test.cjs` 및 필요한 focused regression
- Docs: 이 계획과 기존 계획의 release-gate 기록

## Success Criteria

- [x] Codex planning focused regression이 pending Promise 없이 통과한다.
- [x] `npm run test:backend`가 실패·취소 없이 정상 종료한다.
- [x] `npm test`가 backend와 desktop suite를 모두 실행하고 정상 종료한다.
- [x] 기존 Codex ready/unavailable 및 local-LLM planning 의미가 유지된다.

## Edge Cases

- Codex adapter readiness poll이 plan 요청보다 먼저 시작되는 경우
- relay poll이 job enqueue 직전 또는 직후 timeout 경계에 도달하는 경우
- local-LLM planning 직후 Codex planning이 같은 테스트 프로세스에서 실행되는 경우
- Codex adapter가 ready가 아니어서 `runtime_unavailable`을 반환하는 경우

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] 기존 전체 백엔드 테스트가 Codex planning 직전에 멈추고 `Promise resolution is still pending`으로 취소되는 것을 재현한다.
  - [x] 원인을 가장 작게 고정하는 focused regression을 실패 상태로 관찰한다.
- GREEN:
  - [x] 원인 경계만 수정해 focused ready/unavailable Codex planning 테스트를 통과시킨다.
- REFACTOR:
  - [x] 첫 job이 예상과 달라도 launch를 종료한 뒤 assertion을 보고하도록 focused test ordering만 정리한다.

## Acceptance Gates

- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm test`

건너뛴 gate:

- Gate: `npm run typecheck`, `npm run build:desktop`, 별도 Playwright
  - Reason: desktop/React/Electron 경계를 변경하지 않으며 `npm test`의 desktop suite로 회귀를 확인한다.

## Implementation Checklist

- [x] Step 1: aggregate hang 위치와 취소 메시지를 재현한다.
- [x] Step 2: 최소 3개 가설을 isolated/sequence runtime evidence로 판별한다.
- [x] Step 3: focused RED를 고정하고 최소 수정으로 GREEN을 만든다.
- [x] Step 4: backend와 monorepo 전체 게이트를 정상 종료시킨다.
- [x] Step 5: 디버그 아티팩트를 제거하고 검증 결과·남은 위험을 기록한다.

## Verification Notes

- Command: `npm run test:backend`
  - Result: 172 pass, 0 fail, 1 cancelled; `agent-operations.test.cjs`가 65.684초 후 `Promise resolution is still pending but the event loop has already resolved`로 종료됐다. 마지막 완료 항목은 local-LLM planning이며 다음 Codex planning 테스트가 unresolved 상태였다.
- RED: `node --test --test-name-pattern='^Codex mission planning' tests/agent-operations.test.cjs`
  - Result: 0 pass, 2 fail, 0 cancelled. 두 테스트 모두 actual `/api/missions/launch`, expected `/api/runner/adapters`를 즉시 보고했다.
- GREEN: 같은 focused command
  - Result: 2 pass, 0 fail, 0 cancelled.
- Command: `node --test tests/agent-operations.test.cjs`
  - Result: 105 pass, 0 fail, 0 cancelled.
- Command: `npm run backend:check`
  - Result: backend syntax gate 통과.
- Command: `npm run test:backend`
  - Result: 219 pass, 0 fail, 0 cancelled; 정상 종료.
- Command: `npm test`
  - Result: backend 219/219과 desktop 130/130이 한 명령에서 정상 종료. Desktop test harness의 기존 Vite HMR port 24678 warning은 비실패 경고로 남았다.
- Independent read-only review
  - Result: blocker/critical 없음. Codex ready launch, unavailable 503, zero task creation, 계획 문서 일치를 재확인했다.

## Remaining Risks

- Risk: Codex 실행은 launch 전에 remote adapter catalog round trip을 한 번 더 수행하므로 bridge 지연 또는 오래된 catalog에 영향을 받는다.
  - Mitigation: 명시적으로 ready인 `codex-cli`만 실행하고 나머지는 `runtime_unavailable`로 fail closed한다. ready/unavailable HTTP 경계를 focused regression으로 고정했다.
