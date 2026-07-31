# Plan: Empty Workspace Runner and Agent UX

- Date: 2026-07-31
- Owner: Codex
- Work size: Medium
- Status: Verified

## Goal

빈 Workspace에서 Runner 등록이 필요한 상태와 다음 행동을 정직하게 보여주고, 활성 연결이 생기면 시작 가이드의 Runner 단계를 준비됨으로 표시한다. 에이전트 디렉터리와 Control Home은 기본 에이전트가 없음을 설명하고 Workspace 에이전트를 만들거나 Runner에서 가져오는 행동을 제공한다.

## Non-Goals

- Mode B 전체 생성 마법사를 구현하지 않는다.
- 공식 프로필 또는 샘플 에이전트 fallback을 다시 추가하지 않는다.
- Wiki, Calendar AI 단계의 완료 조건을 구현하지 않는다.
- Runner device protocol, enrollment API, QR 형식을 변경하지 않는다.

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge: 변경 없음
- React UI: onboarding readiness/copy, Runner setup copy, Agent Directory 및 Control Home empty state
- Tests: desktop readiness 및 UI source contract tests
- Docs: 이 계획

## Success Criteria

- [x] Runner가 없거나 오프라인이면 시작 가이드가 등록/재연결 필요 상태와 Runner 설정 진입을 보여준다.
- [x] 같은 Workspace의 활성 Runner가 있으면 엔진 인증/연결 테스트와 무관하게 Runner 등록 단계가 준비됨이다.
- [x] 빈 에이전트 목록은 미리 연결된 에이전트가 없다고 설명하고 만들기/가져오기 CTA를 제공한다.
- [x] Mode A 목표만 위임은 기본값으로 유지되고 공식 프로필 fallback은 추가되지 않는다.

## Edge Cases

- Runner row가 active이고 transport가 끊겼으면 등록 단계는 완료로 유지하되 현재 오프라인임을 표시하고, Control Home의 live execution gate는 계속 차단한다.
- revoked/pending Runner는 등록 완료로 취급하지 않는다.
- Runner 등록 완료가 Wiki 또는 Calendar AI 완료를 대신하지 않는다.
- Runner가 없을 때 가져오기 CTA는 기존 가져오기 화면을 열되 Runner 선택 없음을 정직하게 유지한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] 활성 Runner만으로 Runner 단계가 준비됨이고 Calendar AI는 별도로 남는 readiness test
  - [x] 빈 Agent Directory/Control Home copy와 만들기/가져오기 CTA source contract test
- GREEN:
  - [x] readiness 조건과 상태별 copy를 최소 변경한다.
  - [x] 기존 create/import handler를 재사용하는 empty state를 추가한다.
- REFACTOR:
  - [x] 중복 empty copy와 CSS만 필요한 범위에서 정리한다.

## Acceptance Gates

- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`

건너뛴 gate:

- `npm run backend:check`, `npm run test:backend`, `npm test`
  - Reason: backend/Runner 계약을 변경하지 않는 desktop presentation 작업이며 desktop 전체 test/build를 실행한다.

## Implementation Checklist

- [x] Step 1: readiness와 empty-state 계약 테스트를 RED로 만든다.
- [x] Step 2: onboarding Runner readiness/copy 및 등록 경로를 구현한다.
- [x] Step 3: Agent Directory와 Control Home empty state를 구현한다.
- [x] Step 4: desktop tests, typecheck, build를 통과시키고 리스크를 기록한다.

## Verification Notes

- Command: `node --test tests/onboarding-readiness.test.mjs tests/argo-agent-control-design.test.mjs tests/orca-product-surfaces-design.test.mjs`
  - Result: relevant Runner/empty-roster contracts pass.
- Command: `npm run typecheck`
  - Result: passed.
- Command: `npm --workspace apps/desktop run test`
  - Result: 325/325 passed.
- Command: `npm run build:desktop`
  - Result: passed; Vite emitted the existing large-chunk warning only.
- Command: `AGENT_CALENDAR_E2E_EMPTY_AGENTS=1 EVIDENCE_DIR=.omo/evidence/task-e247169929a8 node apps/desktop/tests/playwright-agent-work-workspace.cjs`
  - Result: empty roster, create CTA, and Runner import CTA passed in Chromium; screenshots saved under `.omo/evidence/task-e247169929a8/`.

## Remaining Risks

- Risk: 실제 장치의 QR 등록과 지문 확인은 로컬 Runner 호스트가 필요하다.
  - Mitigation: 기존 enrollment UI/API 흐름을 유지하고 자동 presentation/test gate와 desktop build를 검증했다. 실제 장치 QR 등록은 수동 확인으로 남는다.
