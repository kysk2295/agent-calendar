# Plan: Relay-backed run actions

- Date: 2026-07-19
- Owner: Codex
- Work size: Boundary
- Status: Verified

## Goal

Relay 스냅샷에서 보이는 완료 런의 승인·중단·재시도 요청을 동일한 Mac mini Hermes 런타임으로 전달해, Desktop에서 유효한 런 액션이 404로 실패하지 않게 한다.

## Non-Goals

- Agent Operations의 `/api/agent-operations/tasks/:id/*` 상태 전이 계약은 변경하지 않는다.
- 런 승인 UI나 승인 의미를 재설계하지 않는다.
- 존재하지 않는 런을 성공 처리하거나 오류를 숨기지 않는다.

## Touched Boundaries

- Backend gateway: `apps/backend/app/railway-gateway-server.js`
- Backend library: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge: 변경 없음
- React UI: 변경 없음
- Tests: `apps/backend/tests/release-blockers.test.cjs`
- Docs: 이 계획 문서

## Success Criteria

- [x] `POST /api/runs/:id/approve`가 온라인 Relay에 `runtime.request` 작업으로 전달된다.
- [x] Relay가 돌려준 HTTP 상태와 공개 가능한 런 응답이 Desktop에 보존된다.
- [x] Relay가 없을 때 기존 Railway fallback 동작과 실제 404 의미는 유지된다.

## Edge Cases

- Relay 런타임이 실제로 런을 찾지 못하면 해당 404를 그대로 반환한다.
- `stop`, `retry`, `approve` 외 런 하위 액션은 허용하지 않는다.
- Relay가 오프라인이면 기존 직접 런타임/fallback 경로를 유지한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] 온라인 Relay에서 승인 요청이 `runtime.request`로 폴링되고 200 승인 응답을 돌려주는 통합 테스트가 현재 404로 실패한다.
- GREEN:
  - [x] 기존 런 액션 경로를 Relay JSON 요청 분기에 포함한다.
- REFACTOR:
  - [x] 중복 조건이 생기면 명명된 불리언 한 개로만 정리한다.

## Acceptance Gates

- [x] `npm run backend:check`
- [x] 관련 `node --test` 통합 테스트
- [x] `npm run test:backend`
- [x] 실제 승인 API 계약 및 Desktop UI 수동 QA

건너뛴 gate:

- Gate: Desktop typecheck/test/build
  - Reason: Desktop 코드는 변경하지 않으며 기존 UI 호출 계약을 그대로 사용한다.
- Gate: Full `npm test`
  - Reason: Backend 전체 게이트가 변경 경계를 완전히 포함한다.

## Implementation Checklist

- [x] Step 1: Relay 온라인 런 승인 요청의 실패 회귀 테스트 추가
- [x] Step 2: 런 액션을 Relay 런타임 요청 분기에 포함
- [x] Step 3: 로컬 테스트와 실제 Railway/Desktop 흐름 검증

## Verification Notes

- Command: 인증된 `GET /api/runs/run-20260715130046-8f66719a`
  - Result: HTTP 200, Relay 런타임에 대상 런 존재
- Command: 인증된 `POST /api/runs/run-20260715130046-8f66719a/approve`
  - Result: HTTP 404, `Run not found in gateway fallback state`
- Command: `npm run backend:check && npm run test:backend && git diff --check`
  - Result: syntax PASS, Backend 288/288 PASS, diff check PASS
- Command: Desktop UI + local gateway + Relay bridge integrated QA
  - Result: 승인 POST HTTP 200, Relay 경로 일치, 검토 행 1→0, 오류 배너 0; 잘못된 `/approve/extra`는 Relay 작업을 생성하지 않음

## Remaining Risks

- Risk: 현재 변경은 아직 commit/push 및 Railway 배포 전이므로 실행 중인 프로덕션 앱에는 반영되지 않았다.
  - Mitigation: 사용자 승인 후 main에 commit/push하고 Railway 배포 상태와 실제 프로덕션 승인 흐름을 확인한다.
