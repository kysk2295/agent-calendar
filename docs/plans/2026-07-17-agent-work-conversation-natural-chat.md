# Plan: Agent Work Conversation 실제 Hermes 자연어 채팅 복구

- Date: 2026-07-17
- Owner: Codex
- Work size: Large / Boundary
- Status: Completed

## Goal

에이전트 탭의 Work Conversation이 실행 안내문이나 `[redacted-command]`를 답변으로 남기지 않고, 담당 Hermes 프로필에 해당 Work의 실제 사용자·에이전트 transcript를 전달해 GPT형 자연어 대화와 후속 문맥을 이어가게 한다.

## Non-Goals

- Work Conversation을 위키 검색 UI로 바꾸거나 검색 청크를 답변 프롬프트에 삽입하지 않는다.
- Work별 동적 세션을 지원하지 않는 전용 Wiki `agent.chat`에 임의의 대화 ID를 만들거나, 하나의 고정 Wiki 세션을 모든 Work가 공유하게 하지 않는다.
- 외부 전송, 게시, 파일 수정 등 Work Conversation의 기존 안전 경계를 완화하지 않는다.
- 이번 수정에서 Desktop의 화면 디자인이나 저장 스키마를 재설계하지 않는다.

## Touched Boundaries

- Backend gateway: `apps/backend/app/railway-gateway-server.js` 실제 Relay/SSE 경계 검증; 제품 코드 변경 없음
- Backend library: `apps/backend/app/lib/agent-work-live-turn.js` transcript 연결 복구
- DB/migrations: 없음; 기존 Work Conversation 이벤트와 원격 Hermes 대화 ID를 재사용
- Electron bridge: 변경 없음; 실제 proxy/SSE 경로 검증
- React UI: 변경 없음이 목표; 기존 live/durable timeline 렌더링 검증
- Tests: `apps/backend/tests/agent-operations.test.cjs`, 실제 Desktop proxy Playwright 검증
- Docs: 이 계획과 검증 결과

## Success Criteria

- [x] `wikicurator` + `hermes` Work turn은 담당 프로필에 현재 Work의 사용자·에이전트 transcript를 정확한 순서로 전달한다.
- [x] 모든 Work live completion payload에는 현재 Work의 실제 사용자 transcript가 포함되며 system-only 요청이 발생하지 않는다.
- [x] 같은 Work의 후속 질문에는 앞 사용자 질문과 에이전트 답변이 함께 전달되어 자연스럽게 문맥을 이어간다.
- [x] 답변은 Hermes 담당 프로필 응답 원문이며, keyword template·bootstrap 안내문·`[redacted-command]`가 아니다.
- [x] 기존 안전 분류, idempotency, 다른 프로필, `local_llm`/`codex` 경로는 회귀하지 않는다.
- [x] 실제 Desktop proxy 화면에서 다양한 질문과 후속 질문이 스트리밍되고 새로고침 후에도 저장된 답변이 보인다.

## Edge Cases

- 첫 Work turn: system 문구 뒤에 실제 최초 사용자 질문이 반드시 포함된다.
- 후속 Work turn: 최대 24개 사용자·에이전트 메시지를 순서대로 포함하고 다른 Work의 기록은 섞지 않는다.
- 오래된 실패 Work: 과거 `[redacted-command]` 기록은 조작하지 않되 새 turn은 복구된 Work transcript로 답한다.
- provider timeout/auth/rate limit: 성공 답변으로 위장하지 않고 기존 typed error/checkpoint 경계를 유지한다.
- 동시 turn/idempotent replay: 기존 Work live-turn lock과 terminal response replay를 유지한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] Work transcript가 session ID 누락으로 system-only payload가 되는 regression
  - [x] 후속 turn이 현재 Work의 사용자 → 에이전트 → 사용자 순서를 유지하는 regression
- GREEN:
  - [x] `liveTurnMessages`에 실제 Work session ID를 전달하는 최소 수정
- REFACTOR:
  - [x] 추가 helper 없이 session ID 전달만 고치는 최소 변경을 유지한다.

## Acceptance Gates

- [x] focused RED/GREEN backend test
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] 실제 Railway 배포 및 Relay online 확인
- [x] 실제 Desktop proxy multi-turn Playwright와 reload 검증
- [x] 다양한 질문의 자연성·문맥·30초 응답 측정
- [x] `npm test`

건너뛴 gate:

- 없음. 완료 시 실행하지 못한 gate와 이유를 명시한다.

## Implementation Checklist

- [x] Step 1: 저장된 실패와 현재 production route를 대조해 `profile.chat`/`agent.chat` 경계 차이를 재현한다.
- [x] Step 2: 질문 원문·Work별 격리 transcript·후속 문맥 계약을 RED test로 고정한다.
- [x] Step 3: 공통 transcript 연결을 복구해 담당 프로필 multi-turn test를 GREEN으로 만든다.
- [x] Step 4: 관련 backend/desktop 전체 회귀와 build를 통과시킨다.
- [x] Step 5: Railway에 배포하고 실제 API 및 Desktop proxy에서 여러 질문·후속·reload를 검증한다.
- [x] Step 6: 결과를 계획에 기록하고 main에 커밋·푸시한다.

## Verification Notes

- Command: production historical conversation read
  - Result: 메시지는 `mission_context`로 접수됐지만 두 turn 모두 `relay_failed` → `[redacted-command]`로 저장됐다.
- Command: fresh production Work multi-turn via `profile.chat`
  - Result: 14–18초 내 스트리밍됐지만 질문을 무시하고 두 번 모두 bootstrap/runtime 안내문을 반환했다.
- Command: same profile/question via production Wiki `agent.chat`
  - Result: 7.5초, `openai-codex/gpt-5.5`, 요청한 사실/미확정 구분 문장을 정확히 반환했다.
- Command: focused Backend transcript/session tests
  - Result: RED는 completion payload의 마지막 사용자 메시지가 비어 있음을 포착했고, 수정 후 핵심 2/2 및 관련 파일 115/115 테스트가 통과했다.
- Command: corrected production deployment `5be61ce0-03bf-4e41-b2b5-717ba963e08c`
  - Result: Railway `SUCCESS`, instance `RUNNING`; 실제 Work와 Relay가 수정된 transcript 경계로 응답했다.
- Command: production `wikicurator` multi-turn Work `mission-work-af2cbb92cbfc26cff4cedd4a`
  - Result: 첫 질문은 6.6초에 스트리밍을 시작해 확정/미확정을 정확히 구분했고, 후속 질문은 8.1초에 시작해 이전 답변 중 미확정 사실만 짧게 답했다. 오류 이벤트는 없었다.
- Command: production profile question matrix
  - Result: `default` 산술, `bizconsultant` 전환 실험, `stockagent` 투자 판단, `uniportpm` 온보딩 가설 모두 질문에 맞는 자연어 답변을 반환했다. 첫 토큰은 각각 약 15.4초, 20.1초, 24.8초, 9.4초였다.
- Command: `AGENT_ID=wikicurator EXECUTION_ENGINE=hermes HEADLESS=true node apps/desktop/tests/playwright-agent-work-configured-runtime.cjs`
  - Result: Desktop Work `mission-work-bbe451c573038cb1cdad6fd4`에서 첫 delta 13.3초, 17개 점진 프레임, 정확한 `703` 답변과 문맥 후속 답변, reload 복원, 375px overflow 없음, Calendar AI 실제 스트리밍까지 통과했다.
- Command: `npm run backend:check`, `npm run typecheck`, `npm run build:desktop`
  - Result: 모두 exit 0.
- Command: `npm run test:backend`, `npm --workspace apps/desktop run test`, `npm test`
  - Result: Backend 273/273, Desktop 138/138, 통합 재실행도 모두 통과했다. Desktop 테스트의 기존 WebSocket 24678 사용 경고 외 실패는 없었다.

## Remaining Risks

- Risk: 긴 Work에서 매 turn 전달하는 transcript가 커질 수 있다.
  - Mitigation: 기존 최근 24개 사용자·에이전트 메시지 제한을 유지하고 실제 first-token/total latency를 여러 turn에서 기록한다.
- Risk: 외부 모델의 긴 답변은 전체 완료까지 30초를 넘을 수 있다.
  - Mitigation: UI는 SSE 첫 delta부터 표시하며 실제 질문 matrix의 모든 첫 토큰은 25초 이내였다. 별도 지연 최적화가 필요하면 답변 길이와 프로필별 모델 설정을 독립 과제로 측정한다.
- Risk: 과거 실패 Work에 저장된 `[redacted-command]` 이벤트는 감사 기록이라 그대로 남는다.
  - Mitigation: 새 Work와 새 turn은 복구됐으며 과거 기록 삭제는 이번 범위에서 수행하지 않는다.
