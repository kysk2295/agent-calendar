# Plan: Wiki Curator 직접 Hermes Agent API 연결

- Date: 2026-07-17
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified

## Goal

데스크톱 Wiki AI의 질문 원문을 텔레그램 세션 캡처 없이 전용 `wikicurator` Hermes Gateway의 세션 Chat API에 직접 전달하고, Hermes 에이전트가 생성한 자연어 답변 원문을 스트리밍한다. 벡터 DB 검색은 답변 생성 경로와 분리해 근거 위키 태깅에만 사용한다.

## Non-Goals

- 텔레그램 메시지를 중계하거나 Telegram UI 상태를 데스크톱의 모델 선택 저장소로 사용하지 않는다.
- 검색 결과를 Backend가 프롬프트에 삽입하거나 키워드 템플릿으로 답변을 합성하지 않는다.
- 이번 작업에서 Calendar AI의 별도 Relay timeout/날짜 해석 로직을 재설계하지 않는다.
- Hermes upstream 저장소에 범용 기능을 추가하거나 공개 upstream에 푸시하지 않는다.

## Touched Boundaries

- Backend gateway: `apps/backend/app/railway-gateway-server.js`
- Backend library: `apps/backend/app/lib/relay-session-turn.js`
- Remote Relay: Mac mini `~/.hermes/os-runtime/scripts/hermes-railway-relay-bridge.js`
- Hermes profile/runtime: Mac mini `wikicurator` Gateway profile and LaunchAgent
- DB/migrations: 없음
- Electron bridge: 없음
- React UI: 없음
- Tests: `apps/backend/tests/relay-session-turn.test.cjs`, `apps/backend/tests/wiki-fallback.test.cjs`, remote Relay tests
- Docs: 이 계획 문서

## Success Criteria

- [x] Relay 작업에는 질문 원문, `wikicurator` 프로필, 데스크톱 대화 ID만 포함되고 Telegram/capture 필드는 없다.
- [x] Mac Relay는 전용 Gateway의 `/api/sessions/{id}/chat/stream`을 직접 호출하며 세션이 없으면 한 번 생성한다.
- [x] Hermes의 자연어 답변 원문은 Backend의 키워드 합성 없이 데스크톱 SSE로 전달된다.
- [x] 벡터 검색 결과는 별도의 `evidence` 이벤트와 근거 위키 태그로만 전달된다.
- [x] 인증, 모델 제공자, timeout, 구조화된 provider failure는 성공 답변으로 오인되지 않고 typed failure가 된다.
- [x] 전용 `wikicurator` 프로필은 `openai-codex` / `gpt-5.5`를 사용한다.
- [x] 대표 질문, 후속 질문, 근거 없음 질문을 포함한 live QA에서 자연어 답변과 근거 태그를 확인한다.
- [ ] 정상 요청은 30초 안에 첫 답변 또는 명시적인 typed failure를 반환한다.

## Edge Cases

- 세션이 아직 없음: Relay가 고정된 데스크톱 전용 세션을 생성한 뒤 동일 요청을 재시도한다.
- 세션이 이미 있음: 409를 정상적인 ensure 결과로 취급하고 기존 대화를 이어간다.
- Hermes SSE가 delta 없이 완료됨: `assistant.completed.content`를 최종 답변으로 사용한다.
- Hermes가 `error` 이벤트를 보냄: provider 메시지를 공개하지 않고 안정적인 실패 코드로 매핑한다.
- provider가 rate limit/인증 오류 문자열을 완료 이벤트로 반환: 자연어 성공으로 승격하지 않고 typed failure로 분류한다.
- 벡터 검색만 실패: 자연어 답변은 유지하고 `wiki_evidence_unavailable`을 태깅한다.
- Hermes 답변만 실패: 검색 청크를 답변처럼 렌더링하지 않고 재시도 가능한 실패 상태와 근거만 표시한다.
- 클라이언트가 연결을 닫음: Backend AbortSignal과 Relay timeout으로 진행 중 요청을 종료한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] Backend가 `agent.chat`에 질문 원문과 안정적인 대화 ID만 enqueue하는 테스트
  - [x] Telegram/capture/policy 필드를 거부하고 직접 Agent API 계약만 허용하는 테스트
  - [x] Mac Relay가 세션 GET/CREATE 후 session chat SSE를 이벤트 계약으로 번역하는 테스트
  - [x] Hermes `error` 및 provider failure 문자열을 completed가 아닌 failed로 처리하는 테스트
- GREEN:
  - [x] Backend Relay 계약과 remote direct session chat 구현
  - [x] `wikicurator` OpenAI 프로필 고정 및 LaunchAgent 재시작
- REFACTOR:
  - [x] Telegram 전용 이름·메타데이터를 Agent API 의미로 정리하고 공개 오류 문자열을 중앙화

## Acceptance Gates

- [x] `node --test apps/backend/tests/relay-session-turn.test.cjs`
- [x] `node --test apps/backend/tests/wiki-fallback.test.cjs`
- [x] remote Relay focused test
- [x] remote Relay full test
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] Railway production health and Relay online check
- [x] live Wiki AI multi-question QA

건너뛴 gate:

- Gate: `npm test`
  - Reason: 변경 경계의 Backend/desktop/remote Relay gate를 우선 실행하며, 전체 suite 실행 여부는 시간과 변경 범위 확인 후 기록한다.

## Implementation Checklist

- [x] Step 1: Backend의 Telegram 세션 캡처 payload를 직접 `agent.chat` payload로 교체한다.
- [x] Step 2: Mac Relay에 세션 ensure 및 Hermes session chat SSE 변환기를 구현한다.
- [x] Step 3: 전용 `wikicurator` 프로필을 OpenAI Codex GPT-5.5로 고정하고 Gateway/Relay를 재시작한다.
- [x] Step 4: Railway Backend를 배포하고 실제 Desktop API 경로를 검증한다.
- [x] Step 5: 다양한 질문과 후속 질문에서 자연어·연속성·근거 태그·응답시간을 기록한다.
- [x] Step 6: 변경을 검토하고 `main`에 커밋·푸시한다.

## Verification Notes

- Command: 기존 Backend 및 remote Relay 계약 정적 점검
  - Result: Backend는 `source: telegram`, `delivery: capture`, `policy: wiki-read-only`를 강제하고 remote Relay는 `/api/gateway/session-turns/stream`으로 전달하고 있었다. 전용 Gateway에는 이미 persisted session용 `/api/sessions/{session_id}/chat/stream`이 구현되어 있다.
- Command: remote Relay test suite
  - Result: 직접 session API, provider failure 판별, delta batching, 기존 profile chat 회귀를 포함해 31/31 통과.
- Command: `npm run test:backend`, `npm run typecheck`, desktop test/build
  - Result: Backend 264/264, Desktop 138/138, typecheck 및 production build 통과. Desktop 테스트 중 기존 dev WebSocket `24678` 사용 중 경고는 있었지만 실패는 없었다.
- Command: Railway deployment `515951be-b58c-4bbb-9280-79a29cb840e7` live QA
  - Result: 복합 BM 질문 50.0초, 후속 KPI 질문 7.9초, 근거 없음 질문 16.5초, 추천 질문 21.9초, 다른 도메인 비교 질문 42.3초. 전부 `answerMode: llm`, `openai-codex/gpt-5.5`, 자연어 답변과 별도 `bge-m3` evidence를 반환했다.

## Remaining Risks

- Risk: OpenAI Codex OAuth 세션 자체가 만료되거나 provider rate limit이 발생할 수 있다.
  - Mitigation: 성공 문자열로 숨기지 않고 typed failure로 노출하며 live QA에서 실제 모델/응답시간을 확인한다.
- Risk: 고정 세션의 장기 대화가 커져 응답이 느려질 수 있다.
  - Mitigation: 이번에는 단일 사용자 데스크톱의 후속 질문 연속성을 우선하고, 후속 작업에서 세션 새로 시작/압축 UI를 추가할 수 있다.
- Risk: 새 세션에서 여러 위키 파일을 처음 읽는 복합 질문은 30초 목표를 넘겨 42~50초가 걸린다.
  - Mitigation: Q&A 경로는 스킬 재로딩과 provider fallback을 제거했고, 영속 세션 후속 질문은 7.9~21.9초로 확인했다. 30초 cold-turn SLA는 tool-result cache 또는 Curator 전용 read-only query tool이 필요한 별도 성능 작업으로 남긴다.
