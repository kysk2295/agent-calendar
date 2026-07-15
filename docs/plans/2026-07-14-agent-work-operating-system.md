# Agent Work Operating System

- Date: 2026-07-14
- Owner: Codex
- Work size: Large / Boundary
- Status: In progress

## Goal

에이전트 탭을 관제 보드 위에 drawer를 여는 화면에서, 하나의 위임 요청이 하나의 전체 수명 작업 대화를 소유하는 작업 운영 공간으로 바꾼다. 사용자가 어느 상태에서든 자연어로 계획·실행·결과를 수정하면 메시지가 실제 작업 명령과 상태 변경으로 이어지고, 계획·승인·진행·차단·산출물·결과·수정 이력이 같은 시간순 대화에 나타나야 한다.

## Non-Goals

- 새로운 외부 발송, 게시, 구매, 삭제, 자격 증명 변경 기능을 추가하지 않는다.
- 범용 에이전트 marketplace, agent builder, LLM 기반 자동 agent router를 만들지 않는다.
- 기존 automation/routine 카드는 Control Home에서 읽기 전용으로 그대로 두며, 이번 변경에서 routine conversation·CRUD·새 persistence를 만들지 않는다.
- Hermes Relay, scheduler, calendar 전체, 전역 앱 shell을 다시 작성하지 않는다.
- 기존 mission, task, session, report 데이터를 삭제하거나 파괴적으로 migration하지 않는다.
- 원시 tool log나 chain-of-thought를 사용자 대화에 노출하지 않는다.

## Work Size

Backend API와 저장된 대화 의미, React 작업 공간, 테스트 계약을 함께 바꾸므로 Boundary이자 Large 작업이다.

## Touched Boundaries

- Backend gateway: `apps/backend/app/railway-gateway-server.js`
- Backend library: `apps/backend/app/lib/agent-operations-api.js`, `agent-operations-service.js`, `agent-operations-interventions.js`, public projection과 store 경계
- DB/migrations: 기존 JSON record로 표현 가능하면 물리 migration 없음; 불가능한 경우에만 additive migration
- Electron bridge: 기존 `/api/*` proxy를 유지하고 새 IPC는 추가하지 않는다.
- React UI: `apps/desktop/src/features/agent-operations/**`, `apps/desktop/src/App.tsx`, typed API adapter
- Tests: `apps/backend/tests/agent-operations.test.cjs`, focused Agent Work Playwright, existing Agent Operations regression
- Docs: `CONTEXT.md`, `docs/adr/**`, `docs/DESIGN.md`, 이 계획, `.omo` execution evidence

## Success Criteria

- [x] 위임 작업을 만들면 계획이나 Task Session이 생기기 전부터 하나의 Work Conversation을 열고 메시지를 보낼 수 있다.
- [ ] 선택한 위임 작업은 Control Home을 대체하는 주 Work Conversation으로 열리고, Back이 Control Home과 원래 focus 지점으로 돌아간다. persistent side list나 drawer는 없다.
- [ ] 사용자 메시지, 에이전트 응답, 계획, 승인, 의미 있는 진행, 차단, 산출물, 결과, 수정 결과가 하나의 시간순 타임라인에 표시된다.
- [x] raw tool activity와 반복 상태 noise는 기본 타임라인에서 제외되며 비밀·개인 경로 redaction을 유지한다.
- [x] 계획 전 요구 변경, 실행 중 pause/resume, 실패 후 retry, 완료 후 수정 요청이 현재 상태에 맞는 실제 명령으로 연결되며, 각 메시지는 `accepted/applied/queued/approval_required/rejected` 중 실제 delivery 상태를 반환한다. 지원되지 않는 외부 발송·게시·구매·삭제는 승인 요청이 아니라 `rejected`/blocked로 끝난다.
- [x] 완료 결과 수정은 같은 Work Conversation에서 새 수정 차수로 기록되고 이전 결과는 보존되며 `currentResultReportId`가 정확히 한 현재 결과를 가리킨다.
- [ ] 목적이 다른 요청은 `follow_up_required`로 현재 작업 변경을 거절하고, 사용자가 새 Delegated Work를 명시적으로 만들도록 안내한다. 이번 릴리스는 새 작업이나 source link를 자동 생성하지 않는다.
- [x] 담당 에이전트는 보이고 실행 엔진은 고급 상세에 머물며, 위임 시 명시한 advanced override는 보존된다. 기존 작업의 담당 에이전트 재배정은 이번 릴리스 범위가 아니다.
- [x] 담당 에이전트를 생략하면 title/objective의 결정적 keyword rule로 Wiki Curator, Business Consultant, official default 중 하나를 고르고 그 이유를 표시한다. LLM router는 사용하지 않는다.
- [ ] 기존 planner, scheduler, Relay callback, report feedback, calendar projection이 거짓 성공 없이 계속 동작한다.
- [ ] 기존 routine/automation 카드는 Control Home에 읽기 전용 상태로 남고 Work Conversation이나 편집 affordance를 얻지 않는다.
- [ ] 1280px, 768px, 375px와 200% zoom에서 주요 흐름이 겹치거나 잘리지 않고 keyboard로 완료된다.

## Edge Cases

- 미션은 생성됐지만 계획, task, report가 아직 없는 상태
- mission thread만 있고 task session이 없는 상태
- 여러 task session의 sequence가 각각 1부터 시작하는 상태에서 전역 시간순으로 합치는 경우
- running 작업의 일반 메시지는 현재 completion에 실시간 주입됐다고 표시하지 않고 다음 attempt에 `queued`로 남으며, pause/cancel만 scheduler checkpoint 기록 후 `applied`로 표시되는 경우
- completed/cancelled 작업에 새 지시가 도착하는 경우
- failed/blocked 작업에서 잘못된 resume/retry 명령
- `수정 차수` 도중 이전 artifact와 최신 artifact를 함께 보존하는 경우
- 긴 한국어 제목, 긴 사용자 메시지, 긴 결과, 빈 agents 목록
- API 실패 시 composer 입력과 현재 선택 작업을 잃지 않는 경우
- 기존 저장 record에 새 optional field가 없는 경우
- 같은 `clientRequestId`/`clientMessageId`가 재시도되거나 서로 다른 payload에 재사용되는 경우
- 8,000자를 넘는 메시지와 200개를 넘는 checkpoint를 cursor pagination으로 읽는 경우

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
- [x] mission-level Work Conversation read/write API가 없어 실패하는 backend route/service test
- [x] 모든 상태의 메시지가 실제 intervention 결과를 반환하지 않아 실패하는 backend domain test
- [x] 여러 session/report를 하나의 안전한 checkpoint timeline으로 투영하지 못해 실패하는 backend/public contract test
  - [ ] drawer가 남아 있고 composer가 session 생성 전 비활성화돼 실패하는 focused Playwright
  - [ ] 완료 결과의 새 `수정 차수`가 같은 대화에 보존되지 않아 실패하는 Playwright
- GREEN:
- [x] 기존 mission-thread/session/store를 재사용하는 최소 work-conversation API와 intervention router
- [ ] 기존 Agent Operations state를 사용하는 typed conversation projection과 full workspace UI
- REFACTOR:
  - [ ] 새 TypeScript/TSX 파일은 250 pure LOC 이하로 역할별 분리
  - [ ] 중복된 drawer/report/session presentation 경로를 안전하게 제거하거나 내부 상세 보기로 축소

## Acceptance Gates

- [x] `npm run backend:check`
- [x] focused backend Agent Operations test
- [ ] `npm run test:backend`
- [x] `npm run typecheck`
- [ ] focused Agent Work Playwright
- [ ] existing Agent Operations and Task Session Playwright
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [ ] `npm test`
- [x] local live gateway HTTP happy path and invalid intervention path
- [ ] Chromium 1280 / 768 / 375 visual QA, keyboard, overflow, reduced motion, 200% zoom
- [ ] final `visual-qa`, `review-work`, and debugging runtime audit

건너뛴 gate:

- Gate: 새 외부 side-effect live execution
  - Reason: 이번 범위는 새 외부 side effect를 추가하지 않으며 기존 안전 경계를 유지한다.

## Implementation Checklist

- [x] Step 1: 기존 mission/thread/task/session/report/store/API/UI/test 경계를 조사하고 `docs/DESIGN.md`에 새 workspace 계약을 고정한다.
- [x] Step 2: mission/thread/initial-event를 한 저장 동작으로 만드는 idempotent 생성 계약을 실패 테스트로 고정하고 구현한다.
- [x] Step 3: timeline projection, truthful delivery state, intervention 명령, 새 수정 차수 task/session/report 계약을 각각 실패 테스트로 고정하고 구현한다.
- [ ] Step 4: full workspace와 always-on composer를 고정하는 Playwright 실패 테스트를 작성한다.
- [ ] Step 5: 관제 홈, 작업 목록, unified timeline, 상세 rail, responsive layout을 구현한다.
- [ ] Step 6: Agent/engine advanced presentation, error/loading/empty/approval/revision 상태를 완성한다.
- [ ] Step 7: focused gate, 전체 regression, live HTTP, real-browser visual/accessibility/manual QA를 수행한다.
- [ ] Step 8: 독립 review와 runtime debugging audit 결과를 반영하고 계획·증거 문서를 완료한다.

## Rollback / Fallback

- 새 API는 기존 mission/task/session/report record 위에 additive하게 동작한다. 현재 전용 feature flag는 구현돼 있지 않으므로 즉시 rollback은 Agent Work route/API 변경 묶음만 범위 있게 되돌리는 방식이다. 단계적 rollout이 필요하면 배포 전에 별도 flag를 추가한다. drawer는 현재 interaction contract가 아니며 기본 fallback으로 다시 노출하지 않는다.
- 기존 Task Session message API와 task transition route는 유지해 calendar와 오래된 UI 진입점을 보호한다.
- 새 optional conversation/revision metadata가 없는 기존 record는 creation/update timestamp와 기존 session events로 투영한다.
- 새 개입을 해석할 수 없는 메시지는 실행 성공을 가장하지 않고 mission context instruction으로 보존하며 사용자가 다음 행동을 확인할 수 있게 한다.
- 기존 tracked/untracked Agent 컴포넌트는 삭제하지 않는다. 각 worker는 대상 파일의 작업 전 diff·untracked 상태·checksum과 자신의 patch를 evidence에 남기며, rollback은 그 patch만 역적용한다.

## Verification Notes

- Discovery: 현재 Task Session message는 `pendingInstructions`와 `user_message` event만 추가하며, task 상태에 따라 `next_checkpoint`, `next_run`, `retry_required`, `mission_context` application mode를 반환한다.
- Discovery: 현재 UI는 mission의 첫 task/session을 active session으로 골라 drawer composer를 활성화하므로, mission 생성 직후에는 실제 상호작용이 막힌다.
- Discovery: existing store already persists mission-thread sessions and ordered session events, making an additive conversation projection possible without immediate physical schema migration.
- Decision: completed-result 수정은 completed task/report를 재사용하지 않는다. 같은 mission 아래 새 `revisionId`, 증가하는 `revisionNumber`를 가진 proposed task/session을 만들고, 새 유효 report가 생긴 뒤에만 mission `currentResultReportId`를 갱신한다.
- Decision: 실행 엔진 요청값과 실제 resolved engine은 구분한다. 요청은 `auto` 또는 advanced override로 보존하고, 실제 증거가 있을 때만 strict optional `resolvedExecutionEngine?: 'hermes' | 'codex'`를 노출한다.
- Decision: 현재 릴리스의 Responsible Agent 계약은 결정적 자동 배정 + 배정 이유 + 위임 시 explicit advanced override다. 기존 작업 재배정은 안전한 persisted contract가 없어 후속 범위로 남긴다.
- Decision: 현재 Relay completion에는 live instruction channel이 없으므로 running 일반 메시지는 다음 attempt용 `queued`다. pause/cancel은 checkpoint event가 기록되기 전에는 `applied`가 아니다.
- Decision: exactly-one conversation은 deterministic ID와 idempotency key, file store 단일 save, PostgreSQL ordered atomic persistence 및 retry/concurrency test로 보장한다.

## Remaining Risks

- Risk: 전체 `npm run test:backend`/`npm test`는 기존 Codex adapter readiness promise에서 멈춘다.
  - Mitigation: bounded baseline은 53개 통과·0개 실패 후 64.8초에 interrupt했고, hang 이후 scheduler/session/delivery 구간은 별도로 27/27 통과했다. 최종 문서에는 full-suite PASS를 주장하지 않는다.
- Risk: 자연어 명령 분류기는 지원하지 않는 새로운 표현을 만날 수 있다.
  - Mitigation: 외부 side effect는 fail closed하고, 고정/조합 semantic matrix와 live HTTP로 지원되는 명령과 내부 편집 문맥을 검증한다.
- Risk: 실제 resolved engine은 실행 증거가 없는 기존/자동 요청에서 알 수 없다.
  - Mitigation: optional 필드를 생략하고 UI는 `확인 불가`를 표시한다. 요청 엔진으로 실제 엔진을 추정하지 않는다.
- Risk: 기존 작업 Responsible Agent 재배정은 persisted authorization/history 계약이 없다.
  - Mitigation: 현재 UI는 위임 시 advanced override만 제공하고 기존 배정과 이유를 읽기 전용 책임 기록으로 유지한다.
- Risk: 최종 독립 review, visual QA, runtime audit가 아직 진행 중이다.
  - Mitigation: Todo 5-7과 F1-F4는 root의 독립 검증 전까지 미완료로 유지한다.

## Verification Notes — confirmed Todo 1-4

- Todo 1 design/tooling: `docs/DESIGN.md` contract scan passed; no package or lockfile change was introduced by the design task.
- Todo 2 atomic creation: focused 13/13 and legacy 4/4 passed; live restart/concurrency/rollback checks confirmed one mission/thread/initial message and idempotent conflict behavior.
- Todo 3 conversation/intervention/`수정 차수`: focused 18/18 plus the bounded semantic matrix passed; unsupported external requests returned `rejected`/`unsupported_external_request` with no approval action; file and transactional PostgreSQL-double restart/atomicity paths passed.
- Todo 4 desktop boundary: focused 14/14 and desktop 89/89 passed at its confirmation point; strict parser/typecheck/build and live backend/SSR checks passed. Later broad desktop evidence has also reached 102/102, but Todo 5-7 and final approval remain open.
- Full-suite exception: full `agent-operations.test.cjs` passed 53 with 0 failures, then reproduced the pre-existing Codex readiness hang and was interrupted at 64.8 seconds. The post-hang region passed 27/27 independently. Therefore neither `npm run test:backend` nor `npm test` is marked passed.
