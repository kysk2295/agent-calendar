# Hermes Command Center Prototype

- Date: 2026-07-13
- Owner: Codex
- Work size: Medium
- Status: Verified UI prototype

## Goal

기존 Mac mini Hermes 에이전트와 크론잡, Agent Operations 미션, Task Session을 하나의 에이전트 작업 운영 화면에서 확인한다. 사용자는 개요 화면에서 자연어로 새 작업을 시작하고, 자동화 실행 일정과 상태를 확인한 뒤, 미션의 상세 세션으로 이어갈 수 있어야 한다.

## Non-Goals

- 새로운 Hermes cron API나 데이터베이스 스키마를 만들지 않는다.
- 프로토타입에서 cron 생성, 수정, 삭제를 구현하지 않는다.
- 실제 Word, 이미지, 바이너리 파일 생성 범위를 넓히지 않는다.
- 기존 캘린더, 위키, 앱 셸을 재설계하지 않는다.

## Touched Boundaries

- Backend gateway: 변경 없음. 기존 `/api/scheduler/jobs`와 `/api/agent-operations`를 사용한다.
- Backend library: 변경 없음.
- DB/migrations: 변경 없음.
- Electron bridge: 변경 없음.
- React UI: `apps/desktop/src/App.tsx`, `apps/desktop/src/features/agent-operations/**`
- Tests: `apps/desktop/tests/playwright-agent-command-center.cjs`와 기존 Agent Operations Playwright
- Docs: `docs/DESIGN.md`, 이 계획 문서

## Success Criteria

- [x] 에이전트 탭 첫 화면에서 Hermes 에이전트, 활성 자동화, 실행 중 작업, 검토 대기 보고 수를 확인한다.
- [x] GPT식 자연어 입력에서 목표를 작성하고 상세 미션 composer로 이어갈 수 있다.
- [x] 기존 Hermes 자동화 목록에서 이름, 담당 프로필, 일정, 상태, 다음 실행을 확인한다.
- [x] 자동화를 선택하면 목적, 마지막 실행, 다음 실행, runtime source를 한 화면에서 확인한다.
- [x] 미션 탭과 Task Session의 기존 실행·보고 흐름이 유지된다.
- [x] 자동화 API가 비었거나 일부 필드가 없어도 거짓 상태를 만들지 않고 빈 상태 또는 확인 필요를 표시한다.
- [x] 1280px, 768px, 375px에서 핵심 텍스트와 명령이 겹치거나 잘리지 않는다.

## Edge Cases

- `/api/scheduler/jobs`가 `jobs` 또는 `schedulerJobs`를 반환하는 경우
- cron 표현식, 사람이 읽는 일정, 다음 실행 중 일부만 있는 경우
- 제거된 프로필이나 담당 프로필이 없는 자동화
- 자동화는 있지만 Agent Operations API가 실패한 경우
- 긴 한국어 작업 지시와 자동화 이름

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] 개요 탭과 지표가 없어서 실패하는 Playwright 테스트
  - [x] Hermes 자동화 목록과 상세 inspector가 없어서 실패하는 Playwright 테스트
  - [x] 자연어 목표가 미션 composer로 전달되지 않아 실패하는 Playwright 테스트
- GREEN:
  - [x] 기존 automation state를 읽는 최소 typed projection과 Command Center 컴포넌트
- REFACTOR:
  - [x] 자동화 필드 정규화와 상태 라벨 중복을 feature 모듈에 모은다.

## Acceptance Gates

- [x] `npm run typecheck`
- [x] `node apps/desktop/tests/playwright-agent-command-center.cjs`
- [x] 기존 Agent Operations Playwright
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] 실제 Chromium 1280 / 768 / 375 시각 QA

건너뛴 gate:

- Gate: backend 전체 테스트
  - Reason: 이번 프로토타입은 기존 읽기 API만 소비하며 backend 제품 코드를 변경하지 않는다.

## Implementation Checklist

- [x] Step 1: 기존 automation hydrate와 Agent Operations UI 경계를 조사한다.
- [x] Step 2: Command Center 사용자 흐름의 실패 Playwright 테스트를 추가한다.
- [x] Step 3: automation projection과 dashboard, inspector, command composer를 구현한다.
- [x] Step 4: 기존 미션·Task Session 회귀 테스트와 responsive visual QA를 수행한다.
- [x] Step 5: 런타임 감사와 독립 리뷰 결과를 기록한다.

## Rollback / Fallback

- 새 화면은 기존 Agent Operations 내부 탭으로만 추가한다. 문제가 생기면 `overview`와 `automations` 탭 및 `automation` prop 연결만 제거하면 기존 미션·에이전트·보고서 흐름으로 복귀한다.
- 자동화 원본이 없으면 미션 화면은 계속 사용할 수 있고, 개요에는 연결 대기 상태를 표시한다.

## Verification Notes

- Discovery: desktop hydrate가 이미 `/api/scheduler/jobs` 결과의 `jobs` 또는 `schedulerJobs`를 `state.automation`에 보관한다.
- Discovery: 기존 미션 상세와 Task Session은 Agent Operations API를 통해 독립적으로 동작한다.
- TDD RED: 최초 Command Center Playwright는 `.agent-command-center`가 없어 예상대로 실패했다.
- Runtime hypothesis 1: 자동화 수가 0으로 보인 원인은 UI parser가 아니라 테스트의 잘못된 `/api/automation` mock이라고 가정했다. 실제 `hermesApi.getAutomation`의 `/api/scheduler/jobs` 계약을 확인하고 mock을 수정하자 자동화 2개가 렌더링되어 가설이 확인됐다.
- Runtime hypothesis 2: 기본 탭을 개요로 바꾸면 기존 미션 생성 경로가 끊길 수 있다고 가정했다. 기존 Playwright가 `미션 만들기`를 바로 찾지 못해 실패했고, `미션` 탭을 명시적으로 선택하는 사용자 흐름으로 갱신한 뒤 미션·엔진 선택·Task Session 회귀 검사가 모두 통과했다.
- Runtime hypothesis 3: 긴 한국어 명령과 자동화 이름이 768px/375px에서 가로 overflow를 만들 수 있다고 가정했다. 각 viewport에서 `scrollWidth <= clientWidth`를 검증하고 캡처를 직접 확인했으며 겹침이나 잘림이 발견되지 않았다.
- Review fix: 375px에서 scheduler 상태가 처음에는 잘리고, 첫 수정에서는 28px 폭 안에서 세로로 접혔다. daemon의 실제 폭과 내부 overflow를 검사하는 회귀 assertion을 추가하고 모바일 상태 행을 전체 폭으로 고정한 뒤 새 캡처에서 `스케줄러 온라인` 전체가 한 줄로 표시되는 것을 확인했다.
- Review fix: 자동화 목록 행에 다음 실행 시각을 추가하고 행 자체에서 이름, 프로필, 일정, 상태, 다음 실행을 모두 확인할 수 있게 했다.
- Boundary fix: Playwright scheduler fixture를 실제 gateway 형태인 `goal`, `agent`, `scheduleDisplay`, `source`로 변경하고 `not_ok` 상태와 `null` 레코드를 포함했다. parser는 정확한 상태값만 매핑하고 불명확한 값은 `확인 필요`로 유지하며 잘못된 레코드는 제외한다.
- Runtime labeling: `hermes-cli-cron`은 `Mac mini Hermes`, gateway scheduler는 `Scheduler gateway`로 구분해 표시한다.
- Composer QA: modal open 시 내부로 focus가 이동하고 Tab focus가 갇히며 Escape로 닫힌다. 생성 요청은 성공했지만 후속 refresh가 실패하는 경우 composer를 닫고 별도 refresh 오류를 표시해 중복 제출을 막는다.
- Focused UI: `HERMES_UI_URL=http://127.0.0.1:5586/ AGENT_COMMAND_CENTER_AUDIT_DIR=apps/desktop/audit/agent-command-center-2026-07-13 node apps/desktop/tests/playwright-agent-command-center.cjs` passed (`automationCount: 2`).
- Regression UI: engine selection, Agent Operations mission, surface buttons, Task Session Playwright scripts passed.
- Desktop gates: typecheck passed, unit suite 75/75 passed, production build passed.
- Visual artifacts: `apps/desktop/audit/agent-command-center-2026-07-13/`에 desktop, automation detail, tablet, mobile 캡처를 저장했다.
- Environment note: 현재 인앱 브라우저의 실제 데이터 탭은 기존 Railway hydrate 응답 대기 때문에 캡처가 멈춘다. 이번 UI는 동일 Vite 앱을 실제 Chromium에서 실행하고 scheduler/operations 응답만 fixture로 대체해 검증했으며 backend 제품 코드는 추가하지 않았다.
- Independent review: visual/design gate `PASS`, final code review `APPROVE` with no blocking findings after the parser, mobile, next-run, modal, and refresh-failure fixes.

## Remaining Risks

- 자동화 API의 실제 Mac mini 레코드가 환경별로 다른 필드명을 사용할 수 있다. UI 경계에서 알려진 공개 필드만 보수적으로 정규화하고 실제 브라우저에서 확인한다.
- cron 수정과 run history 연결은 별도 backend 계약이 필요하며 이번 read-only 프로토타입 이후의 작업이다.
