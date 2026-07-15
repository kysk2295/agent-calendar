# Agent Execution Engine Selection And Deliverables

- Date: 2026-07-13
- Owner: Codex
- Work size: Large / Boundary
- Status: Superseded — implemented portions integrated into `2026-07-14-agent-work-operating-system.md`

> Historical record: this plan captures the earlier engine-first boundary exploration. The current Agent Work Operating System keeps engine selection secondary: the delegation path may carry an explicit advanced override, otherwise it requests `auto`; the UI shows the strict optional actual resolved engine only when execution evidence supplies it. The unchecked items below remain historical and are not a second active delivery plan.

## Goal

사용자가 Agent Operations에서 미션을 만들 때 `자동`, `Hermes`, `로컬 LLM`, `Codex` 중 실행 엔진을 직접 선택하고, 요청한 산출물 종류와 함께 그 선택이 캘린더 작업, Task Session, 실제 원격 실행까지 일관되게 유지되게 한다.

## Non-Goals

- 이번 단계에서 다중 사용자 인증이나 사용자별 Mac mini 연결을 만들지 않는다.
- 엔진이 만들지 않은 Word·이미지 파일을 가짜 링크나 placeholder로 노출하지 않는다.
- 사용자가 명시적으로 선택한 엔진이 실패했을 때 다른 엔진으로 조용히 폴백하지 않는다.
- 기존 위키 그래프나 전체 앱 셸을 재설계하지 않는다.

## Touched Boundaries

- Backend gateway: `apps/backend/app/railway-gateway-server.js`
- Backend library: `apps/backend/app/lib/agent-operations-*.js`, Relay completion adapters
- DB/migrations: JSONB payload 의미 확장; 별도 물리 컬럼은 만들지 않는다.
- Electron bridge: 변경 없음. 기존 `/api/*` proxy를 사용한다.
- React UI: `apps/desktop/src/features/agent-operations/**`, `apps/desktop/src/App.tsx`, `apps/desktop/src/api/hermesApi.ts`
- Tests: `apps/backend/tests/agent-operations.test.cjs`, Agent Operations Playwright
- Docs: `docs/DESIGN.md`, 이 계획 문서

## Contract

- 실행 엔진: `auto | hermes | local_llm | codex`
- 산출물 종류: `report | document | image | file`
- 선택값은 mission에 저장되고 planner가 만든 task와 Task Session에 복사된다.
- `auto`는 작업 종류를 기준으로 엔진을 결정하고 실제 사용 엔진을 task/session event에 기록한다.
- `hermes`는 지정 Hermes profile을 실행한다.
- `local_llm`은 Mac mini Relay의 chat completion 경로를 사용한다.
- `codex`는 Mac mini의 Codex runner 선택을 원격 mission launch 계약에 명시한다.
- 명시 엔진은 unavailable/failed 상태를 그대로 반환한다. 폴백은 `auto`에서만 허용하고, 발생 시 기록한다.
- 기존 저장 데이터에 필드가 없으면 UI와 실행 경계에서 `hermes`와 `report`로 해석한다.

Current integrated contract clarification:

- Requested engine and actual resolved engine are different facts. The requested value is `auto | hermes | local_llm | codex`; the evidence-backed actual field is optional and currently resolves only to `hermes | codex`.
- Missing actual evidence is displayed as `확인 불가`; it is not inferred from `auto` or a legacy default.
- Responsible Agent assignment remains the primary accountability surface. The current release supports automatic assignment with reason plus an explicit advanced override at delegation, but not existing-work reassignment.

## Success Criteria

- [ ] 새 미션 composer에서 제목/목표, Hermes profile, 실행 엔진, 산출물 종류를 선택할 수 있다.
- [ ] API는 허용되지 않은 엔진/산출물을 422로 거절한다.
- [ ] 선택 엔진과 산출물이 mission, task, session 응답에 유지된다.
- [ ] scheduler가 선택 엔진에 맞는 adapter만 호출하고 실제 사용 엔진을 이벤트와 완료 결과에 기록한다.
- [ ] 엔진이 준비되지 않았거나 빈 결과를 반환하면 task가 원인을 포함해 blocked/failed가 되고 다른 엔진으로 바뀌지 않는다.
- [ ] 미션 목록, 작업 타임라인, Task Session에서 선택 엔진과 요청 산출물을 확인할 수 있다.
- [ ] 기존 Weekly Opportunity Brief와 저장 데이터가 계속 동작한다.

## Edge Cases

- 기존 mission/task/session에 새 필드가 없는 경우
- `auto` 선택 후 실제 resolved engine이 달라지는 경우
- 명시한 Codex 또는 로컬 LLM runtime이 준비되지 않은 경우
- 이미지/파일 산출물을 선택했지만 엔진 결과에 실제 artifact URL이 없는 경우
- 긴 한국어 목표와 375px 화면
- planner correction 재시도에서도 동일 엔진이 유지되는 경우

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [ ] 미션 생성 입력이 엔진·산출물을 검증하고 저장하는 backend test
  - [ ] planner가 task/session으로 선택을 전파하는 backend test
  - [ ] scheduler가 Hermes/local LLM/Codex adapter를 정확히 하나만 호출하는 backend test
  - [ ] UI composer가 선택값을 create API에 보내고 화면에 표시하는 Playwright test
- GREEN:
  - [ ] 기존 저장 구조를 유지하는 최소 계약/adapter/UI 구현
- REFACTOR:
  - [ ] engine label/parse/resolve 규칙을 한 모듈로 모으고 중복 분기를 제거한다.

## Acceptance Gates

- [ ] `npm run backend:check`
- [ ] `node --test apps/backend/tests/agent-operations.test.cjs`
- [ ] `npm run test:backend`
- [ ] `npm run typecheck`
- [ ] 관련 Agent Operations Playwright
- [ ] `npm --workspace apps/desktop run test`
- [ ] `npm run build:desktop`
- [ ] `npm test`
- [ ] 실제 Relay에서 Hermes, 로컬 LLM, Codex 선택 요청의 observable 결과 확인
- [ ] 375 / 768 / 1280px 실제 브라우저 시각 QA

건너뛴 gate:

- Gate: 실제 원격 엔진 중 준비되지 않은 경로
  - Reason: runtime 상태가 unavailable이면 성공을 가장하지 않고 blocked evidence를 기록한다.

## Implementation Checklist

- [x] Step 1: 현재 mission planner, scheduler, Relay, JSONB 저장, desktop parser/UI 경계를 조사한다.
- [ ] Step 2: execution engine와 deliverable domain contract의 실패 테스트를 추가한다.
- [ ] Step 3: mission 생성/계획 전파와 engine router를 구현한다.
- [ ] Step 4: composer와 mission/task/session 표시를 구현한다.
- [ ] Step 5: 기존/신규 E2E와 실제 원격 경로를 검증한다.
- [ ] Step 6: 전체 gate, 독립 리뷰, push/deploy를 완료한다.

## Rollback / Fallback

- 새 필드는 기존 JSONB payload에만 추가한다. 문제가 생기면 UI composer를 숨기고 기존 Weekly Opportunity Brief 생성 body로 되돌릴 수 있다.
- 기존 레코드의 기본 해석은 `hermes/report`이므로 데이터 migration 없이 이전 동작을 유지한다.
- Codex 또는 local LLM adapter가 준비되지 않으면 해당 task만 blocked로 기록하고 scheduler 전체와 다른 mission은 계속 처리한다.

## Verification Notes

- Existing baseline: backend 140/140, desktop 75/75, desktop build passed before this feature.
- Discovery: Agent Operations currently routes every task through `runRelayProfileCompletion`; artifact events are labels/links, not generated files.

## Remaining Risks

- Mac mini runtime이 per-run `codex-cli` adapter 계약을 아직 해석하지 않으면 Codex 선택은 명시적인 unavailable 상태로 끝날 수 있다. 실제 Relay E2E로 확인한다.
- Word/image binary 저장과 안전한 다운로드 API는 엔진 선택 계약 이후 별도 작은 vertical slice가 필요할 수 있다. 이번 단계에서는 요청 산출물 종류와 실제 반환 artifact metadata를 거짓 없이 표시한다.
