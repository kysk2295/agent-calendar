# Plan: Agent Work provider-session surface

- Date: 2026-07-25
- Owner: Codex
- Work size: Medium
- Status: Verified

## Goal

에이전트 작업 화면을 동일한 체크포인트 카드가 반복되는 관제 로그에서, Codex와
Claude처럼 한 provider session에서 계속 대화하고 실행 과정을 확인하는 작업 공간으로
재설계한다. 대화, 작업 활동, 승인, 결과물의 위계를 분명히 하되 기존의 내구성 있는
Work Conversation과 provider session 연결 계약은 보존한다.

## Non-Goals

- provider session, Runner, 추론 broker 또는 Gateway API 계약을 변경하지 않는다.
- 새로운 에이전트 provider를 추가하지 않는다.
- 모바일 앱을 시작하지 않는다.
- 보존 중인 Hermes automation connector 변경을 수정하거나 되돌리지 않는다.

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge: 변경 없음
- React UI: `apps/desktop/src/features/agent-operations/**`
- Tests: Desktop 정적 디자인 계약과 실제 Playwright 표면
- Docs: 이 계획과 실제 캡처 증거

## Success Criteria

- [x] 사용자 메시지는 절제된 말풍선, 에이전트 답변은 넓은 읽기 흐름으로 구분된다.
- [x] 계획, 진행, 도구, 오류 체크포인트는 대화 카드가 아닌 조밀한 작업 활동으로 보인다.
- [x] 승인과 결과물은 필요한 행동과 산출물을 보존하면서 대화 안에서 구분된다.
- [x] 헤더는 작업 제목, 상태, 담당 에이전트, 실제 실행 엔진을 한 세션 문맥으로 보여준다.
- [x] 입력창은 이중 테두리 없이 같은 작업 대화에 후속 지시가 이어짐을 명확히 한다.
- [x] 1280px, 768px, 375px 및 dark theme에서 대화와 입력창을 사용할 수 있다.

## Edge Cases

- 긴 작업 제목: 첫 화면을 잠식하지 않고 줄바꿈된다.
- 응답 streaming: 기존 부분 응답과 오류가 에이전트 답변 위계로 표시된다.
- 승인 또는 결과가 있는 checkpoint: 기존 버튼, evidence, current-result 의미를 잃지 않는다.
- provider 실제 엔진 미확인: 추정하지 않고 `엔진 확인 중`으로 표시한다.
- 좁은 화면: 상세 rail이 대화 폭을 압축하지 않고 기존 disclosure로 내려간다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] 메시지, 활동, 결정·결과 presentation 계약과 세션 헤더가 없어서 실패하는 정적 테스트
  - [x] composer 이중 테두리와 모든 checkpoint 카드 표현 때문에 실패하는 CSS 테스트
- GREEN:
  - [x] 기존 데이터와 행동을 바꾸지 않는 최소 markup과 CSS 구현
- REFACTOR:
  - [x] checkpoint kind 분류를 작은 순수 함수로 유지하고 중복 selector를 정리

## Acceptance Gates

- [x] `npm run typecheck`
- [x] focused Desktop node tests
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] 실제 Playwright light/dark/375px 시각 QA

건너뛴 gate:

- `npm run test:backend`
  - Reason: Backend/API/schema 변경이 없는 Desktop presentation 작업이다.
- `npm test`
  - Reason: 보존 중인 미완성 Hermes automation RED 변경이 같은 worktree에 있어 이번
    UI slice와 독립적으로 실패할 수 있다. Desktop 전체 gate는 실행한다.

## Implementation Checklist

- [x] Step 1: 현재 Work Conversation의 카드 반복, 헤더, composer 문제를 테스트로 고정한다.
- [x] Step 2: checkpoint를 message/activity/decision/result presentation으로 분류한다.
- [x] Step 3: session bar, 읽기 중심 timeline, 단일-frame composer, 보조 inspector를 구현한다.
- [x] Step 4: 좁은 화면과 dark theme를 보정한다.
- [x] Step 5: 실제 Desktop 표면에서 대화, streaming, composer, details를 관찰하고 캡처한다.

## Verification Notes

- `node --test apps/desktop/tests/agent-work-provider-session-surface.test.mjs ...`
  - Result: 33/33 pass
- `npm --workspace apps/desktop run test`
  - Result: 281/281 pass
- `npm run build:desktop`
  - Result: renderer와 Electron production build pass
- `AGENT_CALENDAR_E2E_CONVERSATION_SURFACE_ONLY=1 ... playwright-agent-work-workspace.cjs`
  - Result: light와 dark 각각 desktop/tablet/mobile surface 5 checks pass

## Remaining Risks

- Risk: 실제 provider의 raw lifecycle 문구가 이미 checkpoint로 저장된 과거 데이터에서는
  새 활동 표현이 그 문구 자체를 정제하지 않는다.
  - Mitigation: 기존 sanitizer와 checkpoint filter를 유지하고, 이번 범위는 presentation에
    한정한다.

## 2026-07-26 Corrective Pass

사용자 표면 검토에서 선택된 작업 화면이 여전히 에이전트 관리 패널, 대화, 작업 정보
rail로 분할되고 사용자 메시지 말풍선이 넓은 카드처럼 보이는 문제가 확인됐다.

추가 성공 기준:

- [x] 선택된 작업의 두 번째 왼쪽 rail은 에이전트 관리 카드 대신 세션 전환 기능만 보여준다.
- [x] 우측 작업 정보 rail과 `작업 중단` 제어는 기본 대화 화면에 나타나지 않는다.
- [x] 사용자 메시지는 내용 너비에 맞는 중립 말풍선이며 이름과 시간이 말풍선 안에서
  반복되지 않는다.
- [x] 에이전트 답변은 별도 말풍선이나 아바타 카드 없이 넓은 읽기 흐름으로 표시된다.
- [x] 입력창과 대화 본문이 1280px 화면의 중심 작업 영역을 차지한다.
- [x] light와 dark 실제 데스크톱 화면에서 동일한 중립 표면과 한 가지 radius 규칙이 유지된다.

추가 검증:

- RED 후 focused Desktop design contract
- Desktop typecheck
- Playwright selected-work light/dark 표면 및 스크린샷

검증 결과:

- focused design contract: 29/29 pass
- Desktop test: 286/286 pass
- Desktop production build: pass
- Playwright selected-work light/dark: pass
- Evidence:
  - `.omo/evidence/agent-work-orca-chat-light.png`
  - `.omo/evidence/agent-work-orca-chat-dark.png`
