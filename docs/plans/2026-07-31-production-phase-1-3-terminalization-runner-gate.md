# Plan: Production Phase 1.3 terminalization and Runner-ready create gate

- Date: 2026-07-31
- Owner: Codex
- Work size: Large
- Status: Verified

## Goal

위임 작업의 모든 하위 에이전트 작업이 종료되고 유효한 현재 결과가 있으면 위임 작업도 실제 결과에 맞는 종료 상태가 되게 한다. Control Home에서는 현재 준비된 실행 컴퓨터가 없을 때 새 위임 생성을 막고, 기존 작업 탐색은 계속 허용한다.

## Non-Goals

- Wiki archive, memory graph, automation, 실제 실행 엔진 연동은 변경하지 않는다.
- Runner 등록/온보딩 전체 문구나 연결 정책은 재설계하지 않는다.
- DB 스키마, API 응답 스키마, preload 계약은 변경하지 않는다.

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: `apps/backend/app/lib/agent-operations-scheduler-support.js`, task executor/intervention lifecycle seam
- DB/migrations: 변경 없음
- Electron bridge: 변경 없음
- React UI: `apps/desktop/src/features/agent-operations/AgentWorkWorkspace.tsx`
- Tests: `apps/backend/tests/agent-operations.test.cjs`, desktop presentation test
- Docs: 이 계획 문서

## Success Criteria

- [x] 마지막 하위 작업이 완료되고 `currentResultReportId`가 있으면 mission이 `completed`가 된다.
- [x] 하위 작업 종료 결과에 따라 all-cancelled는 `cancelled`, 실패가 섞인 결과 보유 작업은 `failed`가 된다.
- [x] `pendingRevisionId`가 있으면 기존 결과가 있어도 위임 작업을 종료하지 않는다.
- [x] 완료 시 mission thread에 한 번의 사용자 의미 있는 completion checkpoint가 기록된다.
- [x] 현재 준비된 실행 컴퓨터가 없으면 Control Home 생성 호출을 막고 한국어 안내를 보여준다.
- [x] 실행 컴퓨터가 없어도 기존 Work Conversation 열람 경로는 유지된다.

## Edge Cases

- 결과 없는 완료/실패 혼합: 현재 결과가 생길 때까지 mission을 열어 둔다.
- 전부 취소: 결과가 없어도 mission을 `cancelled`로 종료한다.
- 수정 차수 진행 중: `pendingRevisionId`가 있는 동안 이전 결과 때문에 종료하지 않는다.
- 반복 terminalization 검사: 이미 종료된 mission에는 checkpoint를 중복 기록하지 않는다.
- 과거 연결 테스트만 성공한 연결 해제 Runner: 준비된 실행 컴퓨터로 취급하지 않는다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] 모든 작업 완료 + 현재 결과 fixture에서 mission status와 mission-thread completion checkpoint를 기대한다.
  - [x] pending revision fixture에서 mission이 active로 남는 것을 기대한다.
  - [x] 연결 해제/미검증 runner 목록의 생성 presentation이 차단과 실행 컴퓨터 안내를 반환하는지 기대한다.
- GREEN:
  - [x] 기존 `updateAgentMission`/session event 경로를 사용한 최소 terminalization helper를 추가한다.
  - [x] 기존 `isRunnerCurrentlyReady`를 사용하는 Control Home submit guard와 안내를 추가한다.
- REFACTOR:
  - [x] executor와 intervention이 같은 terminalization helper를 사용하게 정리하고 중복 checkpoint를 방지한다.

## Acceptance Gates

완료 전에 관련 명령을 실행한다.

- [x] `npm run backend:check`
- [x] targeted backend test
- [x] `npm run typecheck`
- [x] targeted desktop test
- [x] relevant desktop Playwright scenario 또는 실행 불가 사유 기록
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`

건너뛴 gate:

- Gate: `npm run test:backend`
  - Reason: 519개 중 518개 통과 후 무관한 Phase 3 PostgreSQL teardown 비동기 경합 1건으로 실패했다. 해당 `phase3-durable-execution.test.cjs`를 단독 재실행해 15/15 통과를 확인했다.
- Gate: programming skill no-excuse audit
  - Reason: 프로젝트 TypeScript 5.7은 audit script가 요구하는 `typescript/unstable/*` API를 제공하지 않아 실행할 수 없었다. 저장소의 `npm run typecheck`와 전체 Desktop test/build는 통과했다.

## Implementation Checklist

- [x] Step 1: terminalization RED 테스트를 작성하고 기대 이유로 실패를 확인한다.
- [x] Step 2: mission terminalization과 completion checkpoint를 최소 구현한다.
- [x] Step 3: pending revision 및 취소/실패 의미를 회귀 검증한다.
- [x] Step 4: Runner-ready create presentation RED 테스트를 작성하고 실패를 확인한다.
- [x] Step 5: Control Home create guard와 실행 컴퓨터 안내를 구현한다.
- [x] Step 6: acceptance gates와 수동 UI 시나리오를 실행하고 결과를 기록한다.

## Verification Notes

- Command: `npm run backend:check`
  - Result: 통과.
- Command: targeted `agent-operations.test.cjs`
  - Result: 112/112 통과. 새 terminalization 및 revision 회귀 테스트 포함.
- Command: `npm run typecheck`
  - Result: 통과.
- Command: `npm --workspace apps/desktop run test`
  - Result: 305/305 통과.
- Command: `npm run build:desktop`
  - Result: renderer/electron production build 통과. 기존 500 kB chunk 경고만 남음.
- Command: Runner ready/disconnected Playwright workspace scenarios
  - Result: 준비됨에서 생성+계획 성공, 연결 해제에서 생성 요청 0건과 기존 Work Conversation 열람 성공.
- Evidence: `.omo/evidence/production-phase-1-3/runner-blocked/desktop-control-home-runner-required.png`
  - Result: 실행 컴퓨터 연결 안내와 disabled 위임 버튼을 시각 확인.

## Remaining Risks

- Risk: file store의 mission update와 checkpoint append는 별도 public operation이다.
  - Mitigation: task/session/result를 먼저 영속화한 뒤 idempotent한 terminal status guard를 적용하며, 현재 store가 제공하는 update/event 경로를 재사용한다.
- Risk: 전체 backend 병렬 suite에서 Phase 3 PostgreSQL teardown 경합이 재현될 수 있다.
  - Mitigation: 관련 Agent Operations 파일은 112/112, 실패 파일은 단독 15/15 통과했으며 이번 변경과 무관한 suite-level 경합으로 기록한다.
