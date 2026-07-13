# Agent Workflow Clarity

## Goal

Agent Operations의 첫 화면에서 에이전트가 지금 무엇을 하고 있고, 다음 작업은 무엇이며, 사용자가 어디에서 세션을 열고 개입할 수 있는지 Codex 작업 화면처럼 즉시 이해되게 한다.

## Non-goals

- Hermes 실행, scheduler, callback, 보고서 API 계약은 변경하지 않는다.
- 새 에이전트 종류나 가짜 진행 데이터를 추가하지 않는다.
- 전체 앱 셸이나 다른 캘린더·위키 화면을 재설계하지 않는다.

## Work size

Medium. Desktop React Agent Operations 화면, 해당 CSS, Playwright 계약과 디자인 문서를 변경한다.

## Touched boundaries

- Desktop UI: `apps/desktop/src/features/agent-operations/**`
- Desktop visual contract: `apps/desktop/src/features/agent-operations/agent-operations.css`
- UI tests: `apps/desktop/tests/playwright-agent-operations-*.cjs`
- Design and plan: `docs/DESIGN.md`, `docs/plans/**`

## Success criteria

- 선택한 미션의 상태, 완료 진행률, 현재/다음 작업과 담당 에이전트가 첫 viewport에 보인다.
- 작업은 실행 순서를 읽을 수 있는 세로 타임라인으로 표시되고 상태·일정·예상 시간·기대 결과를 함께 보여준다.
- 세션이 있는 작업에는 명시적인 `세션 열기` 명령이 있고, 예약 작업에는 `지금 실행`이 주 명령으로 보인다.
- 계약·정책 정보는 작업 흐름을 방해하지 않는 보조 rail로 이동한다.
- 모바일에서는 미션 선택 다음에 작업 타임라인이 먼저 나오고 정책 rail은 그 뒤에 나온다.
- 기존 Task Session 대화, 승인, 일시정지, 취소, 재시도 동작은 유지된다.
- Hermes 최종 JSON 응답은 핵심 결과·근거·한계·다음 작업으로 구조화되어 보인다.

## Edge cases

- 작업이 아직 없는 초안 미션
- 세션이 아직 생성되지 않은 proposed 작업
- 완료·취소·실패 작업이 섞인 미션
- 긴 한국어 제목과 기대 결과
- 375px 모바일, 768px 태블릿, 1280px 데스크톱

## Test plan

- Playwright에 새 요약·타임라인·명시적 세션 버튼·한국어 탭 계약을 먼저 추가하고 RED를 확인한다.
- Task Session의 Hermes 결과 구조화 계약을 추가하고 `.task-session-result` 부재로 RED를 확인한다.
- 최소 JSX/CSS 변경 후 같은 Playwright를 GREEN으로 만든다.
- desktop typecheck, 75개 단위 테스트, production build를 실행한다.
- 실제 데이터 화면을 375/768/1280에서 캡처하고 overflow와 첫 viewport 정보 순서를 확인한다.

## Acceptance gates

- `HERMES_UI_URL=http://127.0.0.1:5586/ node apps/desktop/tests/playwright-agent-operations-mission.cjs`
- `HERMES_UI_URL=http://127.0.0.1:5586/ node apps/desktop/tests/playwright-agent-mission.cjs`
- `HERMES_UI_URL=http://127.0.0.1:5586/ node apps/desktop/tests/playwright-agent-surface-buttons.cjs`
- `HERMES_UI_URL=http://127.0.0.1:5586/ node apps/desktop/tests/playwright-agent-task-session.cjs`
- `npm run typecheck`
- `npm --workspace apps/desktop run test`
- `npm run build:desktop`

## Step-by-step checklist

- [x] RED: 현재 화면에서 누락된 작업 요약, 타임라인, 세션 명령 계약을 추가한다.
- [x] 디자인 시스템에 Mission live summary와 Work timeline primitive를 정의한다.
- [x] Mission list에 진행률과 다음 작업 정보를 추가한다.
- [x] Mission detail을 작업 중심 main + 계약 context rail로 재배치한다.
- [x] Task row를 순서가 보이는 타임라인과 명시적 세션/실행 명령으로 바꾼다.
- [x] Task Session의 Hermes 최종 결과를 읽을 수 있는 구조로 바꾼다.
- [x] 모바일 정보 순서와 긴 텍스트 wrapping을 검증한다.
- [x] 전체 desktop gate와 실제 브라우저 visual QA를 통과한다.

## Rollback / fallback

- API와 persisted data는 건드리지 않는다. 문제가 생기면 새 layout class와 CSS만 이전 mission contract 배열로 되돌릴 수 있다.
- Task Session dialog의 API 계약은 유지하며, 구조화 렌더링에 실패하면 기존 일반 텍스트 표시로 안전하게 돌아간다.

## Remaining risks

- 실행 중 작업의 세부 token/tool streaming은 현재 session event polling 주기에 의존한다.
- 전체 Codex 앱과 동일한 thread navigation은 범위 밖이며, 이번 단계는 현재 Agent Operations 데이터로 가능한 작업 가시성과 개입성에 집중한다.

## Verification evidence

- RED: Task Session 테스트에서 `.task-session-result`가 `0 !== 1`로 실패했다.
- GREEN: mission, surface, Task Session Playwright가 모두 통과했고 Task Session은 실제 Hermes 결과를 구조화해 표시했다.
- Runtime hypothesis 1, 좁은 화면에서 수평 overflow가 생긴다: 375px 실제 브라우저에서 document, panel, result overflow가 모두 `false`여서 기각했다.
- Runtime hypothesis 2, 명시적인 세션 명령이 실제 세션으로 이어지지 않는다: 실제 완료 미션의 `세션 열기` 3개를 확인하고 하나를 열어 4개 관련 세션과 시간순 이벤트를 확인해 기각했다.
- Runtime hypothesis 3, 실제 Hermes JSON이 구조화 파서에 맞지 않는다: 실제 세션에서 `.task-session-result` 1개와 핵심 결과·근거·한계·다음 작업을 확인해 기각했다.
- 태블릿 내부 overflow: 768px에서 mission contract `311/311`, live summary `277/277`, work plan `279/279`의 client/scroll width를 확인했다.
- 모바일 개입성: 375x812에서 composer가 `top=693`, `bottom=812`로 viewport 안에 고정되고 event 영역만 `527/2391`로 스크롤됨을 확인했다.
- Hermes 코드 펜스 결과: JSON 코드 펜스가 포함된 응답도 `.task-session-result`로 구조화되는 Playwright 계약을 RED→GREEN으로 확인했다.
- CJK 정밀도: 작업 제목과 결과 본문은 `word-break: keep-all`, 결과 제목은 `text-wrap: balance` 계약을 추가해 조사·단어 내부 분리를 막았다.
- Fresh captures: `apps/desktop/audit/agent-workflow-clarity-2026-07-13/`의 mission, session, session-result 상태를 1280x800, 768x900, 375x812에서 각각 저장했다.
- Independent visual QA: 디자인/기능 integrity와 visual/CJK precision 두 pass 모두 최신 9개 캡처 기준 `PASS`했다.
- Legacy E2E entrypoint: 제거된 `.mission` UI에서 timeout 나던 `playwright-agent-mission.cjs`를 현재 Agent Operations 미션 E2E의 호환 진입점으로 바꾸고 `operationRequests=8`로 통과했다.
- Final code review: API task order와 scheduler order 불일치, 취소 작업의 완료 오인, 제목 없는 유효 보고서의 raw JSON 노출, 영어 `Agents` selector 회귀를 RED→GREEN으로 수정했다.
- 일정은 `mission.timezone`으로 표시하고, 순서 표식과 세션 버튼에 고유 accessible name을 제공하며, AI 배열의 React key 충돌 가능성을 제거했다.
- `npm test`: backend 140/140, desktop 75/75 통과.
- `npm run build:desktop`: renderer와 Electron build 통과.
