# Plan: Orca Control Home fidelity pass

- Date: 2026-07-25
- Owner: Codex
- Work size: Medium
- Status: Complete

## Goal

Agent Work Control Space의 Control Home을 실제 Orca처럼 작업 큐가 중심인 조밀한
도구 화면으로 정리한다. 색상만 닮은 카드형 대시보드가 아니라, 진행 작업과 승인을
먼저 읽고 실행 환경과 자동화는 보조 레일에서 확인하는 구조로 바꾼다.

## Non-Goals

- Unified Calendar, Wiki, Runner 설정, 온보딩의 정보 구조를 다시 바꾸지 않는다.
- Backend, Runner 실행 계약, 자동화 계약 또는 저장 데이터 의미를 바꾸지 않는다.
- Orca의 로고, 작업트리 용어, 터미널 중심 정보 구조를 복제하지 않는다.
- Agent Work Conversation의 실행 상태나 개입 정책을 바꾸지 않는다.

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge: 변경 없음
- React UI: `AgentControlRoomBoard.tsx`
- Styling: `agent-workspace.css`
- Tests: Orca 제품 표면 디자인 계약, Agent Work 회귀, 실제 화면 QA
- Docs: 이 계획과 검증 증거

## Design Read

- Mode: 기존 IA를 보존하는 Desktop product redesign
- Reference: Orca의 main work pane + narrow context rail
- Design variance: 3
- Motion intensity: 2
- Visual density: 6
- Shape rule: 입력과 버튼은 7px, 데이터 행은 radius 0
- Color rule: neutral surfaces + 기존 terracotta primary action 1개

## Success Criteria

- [x] 진행 작업과 승인 대기가 Control Home의 첫 번째 읽기 영역이다.
- [x] 에이전트 상태와 자동화는 320px 보조 레일에서 평평한 행으로 표시된다.
- [x] 최근 작업 대화와 최근 활동은 카드 벽이 아니라 구분선 기반 목록이다.
- [x] 장식용 화살표, 체크, 시계 문자 대신 기존 Phosphor 아이콘 체계를 사용한다.
- [x] 빈 상태는 점선 상자 없이 한 줄 설명만 표시한다.
- [x] 1280px, 768px, 375px와 light/dark에서 수평 overflow나 잘림이 없다.

## Edge Cases

- 에이전트나 자동화가 없어도 보조 레일 폭과 구분선이 무너지지 않는다.
- 긴 한국어 작업명은 의미를 자르지 않고 자연스럽게 줄바꿈한다.
- 승인 버튼은 44px 최소 높이와 키보드 초점을 유지한다.
- 980px 이하에서는 보조 레일이 작업 큐 아래로 이동한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] workbench + context rail 구조와 장식 문자 제거 계약이 기존 코드에서 실패한다.
- GREEN:
  - [x] 기존 selector와 클릭 동작을 유지한 최소 JSX/CSS 변경을 적용한다.
- REFACTOR:
  - [x] 사용하지 않는 이전 column selector와 반복 시각 규칙을 제거한다.

## Acceptance Gates

- [x] `node --test apps/desktop/tests/orca-product-surfaces-design.test.mjs`
- [x] `node --test apps/desktop/tests/agent-work-design-system.test.mjs apps/desktop/tests/agent-work-live-stream.test.mjs`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] 실제 renderer light/dark QA

건너뛴 gate:

- Backend gates:
  - Backend 계약을 변경하지 않으므로 Desktop 전체 gate가 통과하면 생략한다.
- Lighthouse:
  - 인증된 Electron 제품 표면에 맞는 harness가 없어 실제 화면 overflow와 대비 검사로
    대체한다.

## Implementation Checklist

- [x] Step 1: Orca 공개 화면과 소스 토큰을 현재 Control Home과 비교한다.
- [x] Step 2: workbench/rail 구조 계약을 RED로 고정한다.
- [x] Step 3: Control Home JSX와 CSS를 조밀한 행 기반 구조로 바꾼다.
- [x] Step 4: light/dark와 세 너비에서 실제 화면을 확인한다.
- [x] Step 5: 제한된 한 명의 독립 리뷰를 반영한다.

## Verification Notes

- Orca references:
  - `https://www.onorca.dev/docs`
  - `https://github.com/stablyai/orca`
- Source audit:
  - light `#fff/#fafafa/#e5e5e5`, dark `#0a0a0a/#171717/7% border`
  - active selection 외에는 border와 surface 차이만 사용
- Renderer QA:
  - light/dark 각각 1280px, 768px, 375px 캡처 완료
  - desktop workbench는 `684px 320px`, compact 너비에서는 단일 column
  - 모든 너비에서 document horizontal overflow 없음
- Verification:
  - focused design and Agent Work tests: 30/30 passed
  - Desktop tests: 240/240 passed
  - typecheck, production desktop build, `git diff --check`: passed
- Independent review:
  - reviewer: `orca_design_final_review`
  - reviewed HEAD: `16d59256801d822e3430cdd30eaa7b56d58ecab9`
  - verdict: `PASS / APPROVE`
  - report: `.omo/evidence/orca-control-home-fidelity-pass-clone-fidelity.md`

## Remaining Risks

- `agent-workspace.css`는 기존부터 큰 파일이다. 이번 변경은 Control Home selector에만
  제한하고 Work Conversation 규칙은 건드리지 않는다.
- 전체 Agent Work 브라우저 시나리오는 디자인 검증 뒤의 기존 메시지 재시도 단계에서
  전송 버튼이 `응답 중`으로 남아 실패한다. 이번 범위에서는 로그인/session fixture를
  복구하고 Control Home 전용 light/dark 검증 경로를 통과시켰으며, 해당 후반 동작
  문제는 디자인 변경과 분리된 후속 위험으로 남긴다.
