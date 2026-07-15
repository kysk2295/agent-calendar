# Agent Work Conversation Redesign

- Date: 2026-07-14
- Owner: Codex
- Work size: Medium
- Status: Superseded — integrated into `2026-07-14-agent-work-operating-system.md`

> Historical record: this plan documents the completed drawer-based intermediate redesign. The Agent Work Operating System supersedes its navigation and interaction contract with Control Home → selected primary Work Conversation → Back. Drawer references below describe the historical implementation and are not the current product contract.

## Goal

에이전트 탭을 `apps/desktop/prototypes/agent-tab.html`의 관제 화면을 기준으로 재설계한다. 사용자는 상단에서 원하는 결과를 자연어로 위임하고, 에이전트 상태·진행 중 작업·승인 대기·활동을 한 화면에서 파악한다. 작업을 선택하면 오른쪽 작업 스레드에서 계획, 진행, 결과, 후속 대화로 이어간다.

## Non-Goals

- 새로운 backend API, DB schema, Electron IPC를 추가하지 않는다.
- 이번 단계에서 파일 업로드 계약을 새로 만들지 않는다.
- Hermes cron 생성·수정·삭제 기능을 추가하지 않는다.
- 기존 Task Session 실행 및 callback 계약을 변경하지 않는다.

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge: 변경 없음
- React UI: `apps/desktop/src/features/agent-operations/**`, `apps/desktop/src/App.tsx`
- Tests: Agent Operations Playwright workflows
- Docs: `docs/DESIGN.md`, 이 계획

## Success Criteria

- [x] 별도 `개요`, `미션`, `보고서` 탭 없이 에이전트 관제 화면을 기본 화면으로 표시한다.
- [x] 화면 구조와 시각 토큰은 `apps/desktop/prototypes/agent-tab.html`의 헤더, 위임 바, 에이전트 상태 카드, 2열 작업 영역, 오른쪽 스레드 drawer를 따른다.
- [x] 진행 중 작업, 승인 대기, 활동 타임라인이 실제 mission/task/report/automation 상태에서 생성된다.
- [x] 진행 카드와 관련 활동을 선택하면 해당 작업의 오른쪽 대화 drawer가 열린다.
- [x] `리서치`, `위키 정리`, 산출물 종류, 파일 형식, 미션 제목 입력을 제거한다.
- [x] 자연어 요청과 선택한 에이전트·실행 엔진만으로 작업을 바로 생성한다.
- [x] 작업 제목은 요청에서 자동 생성되고 기본 산출물 계약은 사용자에게 노출하지 않는다.
- [x] 작업 drawer에서 사용자 요청, 계획, 진행 작업, 결과를 시간 순서로 확인한다.
- [x] 계획 생성·승인, 작업 실행·상태 변경, Task Session 열기 동작을 유지한다.
- [x] 결과는 별도 보고서 탭이 아니라 해당 작업 대화에 표시한다.
- [x] 스케줄러 상태와 반복 작업의 마지막/다음 실행을 관제 화면과 활동에서 계속 확인한다.
- [x] 1280px, 768px, 375px에서 입력, 작업 기록, 상태, 주요 명령이 겹치거나 잘리지 않는다.

## Edge Cases

- 미션, 작업, 결과가 모두 없는 첫 사용자
- 작업은 생성됐지만 아직 계획이 없는 상태
- 제안된 계획의 승인이 필요한 상태
- Task Session이 아직 없거나 여러 개인 상태
- 긴 한국어 요청과 긴 작업 제목
- agent 목록이 비었거나 scheduler source가 불명확한 상태

## Test Plan

- RED:
  - [x] 기존 탭/rail 중심 UX 때문에 실패하는 `agent-tab.html` 관제 화면 Playwright
  - [x] 대화 composer에서 즉시 미션을 생성하지 못해 실패하는 Playwright
  - [x] 결과가 작업 대화 안에 없어서 실패하는 Playwright
- GREEN:
  - [x] 기존 Agent Operations state를 사용하는 status cards, running/approval/activity sections
  - [x] 기존 mission/task/report actions를 오른쪽 작업 drawer에 연결
- REFACTOR:
  - [ ] 제거된 command center와 modal composer의 dead UI를 정리
  - [ ] 새 CSS를 독립 feature stylesheet로 분리

## Acceptance Gates

- [x] focused Agent Work Playwright
- [x] 기존 Agent Operations·Task Session Playwright
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] Chromium 1280 / 768 / 375 visual QA
- [x] keyboard and overflow QA

건너뛴 gate:

- Gate: backend 전체 테스트
  - Reason: 기존 create/plan/approve/task/session API를 그대로 소비하는 UI 재설계이며 backend 제품 코드를 변경하지 않는다.

## Implementation Checklist

- [x] Step 1: 현재 command center, mission composer, report tab, Task Session 경계를 조사한다.
- [x] Step 2: GPT형 작업 대화의 화면·상태·반응형 계약을 `docs/DESIGN.md`에 정의한다.
- [x] Step 2a: `agent-tab.html`을 실제 렌더링해 관제 화면과 작업 drawer를 새 기준으로 채택한다.
- [x] Step 3: 새 사용자 흐름을 고정하는 실패 Playwright를 작성한다.
- [x] Step 4: 에이전트 관제 board와 direct delegate composer를 구현한다.
- [x] Step 5: 기존 mission actions, 결과, session 진입을 작업 drawer에 연결한다.
- [x] Step 6: 회귀, 반응형, 접근성, visual QA를 수행한다.
- [x] Step 7: runtime audit 결과와 독립 review 시도 상태를 기록한다.

## Rollback / Fallback

- 새 작업 workspace는 기존 Agent Operations API 계약 위에서만 동작한다. 문제가 생기면 `AgentOperationsScreen`에서 기존 overview/missions 렌더링을 복구할 수 있으며 backend 데이터에는 영향을 주지 않는다.
- 작업 생성이 실패하면 입력을 유지하고 기존 error status를 노출한다.

## Verification Notes

- Product intent: 대화에서 목표와 맥락을 전달하고 같은 대화에서 계획 검토, 진행 확인, 방향 수정, 결과 수정을 이어가는 GPT Work 흐름을 Hermes 작업과 캘린더 자동화에 적용한다.
- Existing capability: mission create/plan/approve, task actions, Task Session message, reports, scheduler jobs API는 이미 존재한다.
- RED evidence: `playwright-agent-command-center.cjs`가 `.agent-control-room` 부재로 실패했고, 스케줄러 카드 추가 전에는 상태 카드 `2 !== 3`으로 실패했다.
- GREEN evidence: Agent command center, engine selection, surface buttons, mission lifecycle, task session, profile status Playwright가 모두 통과했다.
- Build evidence: desktop typecheck, 75 desktop unit/integration tests, production desktop build가 통과했다.
- Visual evidence: `apps/desktop/audit/agent-control-room-2026-07-14/`의 desktop, drawer, tablet, mobile 캡처를 직접 검사했다. `agent-tab.html`은 기존 앱 shell과 fixture가 달라 구조적 기준이며 full-frame pixel diff는 정확한 합격 지표로 사용하지 않는다.
- Runtime audit hypothesis 1: 상단 위임 바가 선택한 에이전트/엔진과 자연어 목표를 기존 mission create 계약으로 보낸다. Engine/command-center Playwright로 확인했다.
- Runtime audit hypothesis 2: 진행·활동 카드에서 열린 drawer가 계획 승인, task 상태 변경, 결과 피드백, Task Session 재진입을 실제 핸들러에 연결한다. Mission/task-session Playwright로 확인했다.
- Runtime audit hypothesis 3: 실서버 화면에서 Shift+Enter, Codex 선택, drawer 열기/닫기, 375px overflow와 console error를 확인했다. 줄바꿈·엔진 선택·drawer 폭·무오류·수평 overflow 없음이 모두 확인됐다.
- Independent visual review: 두 read-only reviewer를 병렬 실행했으나 모델 capacity 대기에서 4분 이상 결과를 반환하지 않아 종료했다. 대신 reference/actual 직접 이미지 검사, motion settled capture, full focused Playwright, 실브라우저 QA를 완료했다.

## Remaining Risks

- 파일 첨부는 현재 work creation 계약에 없으므로 별도 boundary 작업이 필요하다.
- 이 계획의 Task Session 이후 메시지 제한과 drawer navigation은 후속 Agent Work Operating System에서 대체됐다. 현재 계약은 계획/Task Session 생성 전부터 Work Conversation 메시지를 받으며, 선택 작업이 Control Home을 대체한다.
