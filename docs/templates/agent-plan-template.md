# Plan: <기능 또는 수정 이름>

- Date: YYYY-MM-DD
- Owner: Codex
- Work size: Small | Medium | Large | Boundary
- Status: Draft | In progress | Verified

## Goal

사용자에게 보이는 결과를 한두 문장으로 적는다.

## Non-Goals

- 이번 작업에서 하지 않을 일을 적는다.
- 끌려가기 쉬운 인접 작업을 명시적으로 제외한다.

## Touched Boundaries

- Backend gateway:
- Backend library:
- DB/migrations:
- Electron bridge:
- React UI:
- Tests:
- Docs:

## Success Criteria

- [ ] 기준 1
- [ ] 기준 2
- [ ] 기준 3

## Edge Cases

- 케이스 1:
- 케이스 2:
- 케이스 3:

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [ ] 먼저 실패해야 하는 테스트:
- GREEN:
  - [ ] 최소 구현 목표:
- REFACTOR:
  - [ ] green 이후 허용되는 정리:

## Acceptance Gates

완료 전에 관련 명령을 실행한다.

- [ ] `npm run backend:check`
- [ ] `npm run test:backend`
- [ ] `npm run typecheck`
- [ ] `npm --workspace apps/desktop run test`
- [ ] `npm run build:desktop`
- [ ] `npm test`

건너뛴 gate:

- Gate:
  - Reason:

## Implementation Checklist

- [ ] Step 1:
- [ ] Step 2:
- [ ] Step 3:

## Verification Notes

방금 실행한 명령 결과 요약을 기록한다.

- Command:
  - Result:

## Remaining Risks

- Risk:
  - Mitigation:
