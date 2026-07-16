# Telegram Session Turn for Desktop Wiki AI

- Date: 2026-07-16
- Status: Approved design
- Work size: Large / Boundary
- Selected behavior: Telegram 세션 문맥 공유, 데스크톱에만 질문·답변 표시

## Goal

Agent Calendar의 위키 질문을 ChatGPT의 동일 conversation 후속 질문처럼 현재
Telegram `wikicurator` 세션에 하나의 turn으로 추가한다. 현재 세션의 transcript,
provider/model 설정(현재 OpenAI `gpt-5.5`), 큐레이터 정체성을 그대로 사용하고 생성 토큰을 즉시
데스크톱으로 스트리밍한다. 질문과 답변은 Telegram 화면에는 전송하지 않는다.

벡터 검색은 큐레이터 질문을 수정하는 prompt가 아니다. 질문과 병렬로 실행하고,
결과를 답변 아래의 클릭 가능한 근거 위키 태그로만 표시한다.

## Current Problem

현재 데스크톱 경로는 Telegram 세션의 provider/model route만 복사한 뒤 별도의
Hermes mission/process를 시작한다. 위키 검색, Relay polling, 새 process 실행,
process 종료, complete 전송을 순차적으로 기다린다. 실제 패키징 앱 검증에서는
자연어 답변이 표시되기까지 약 110초가 걸렸다. Telegram은 기존 Gateway session과
실행 loop를 바로 사용하고 생성 중간 상태를 표시하므로 체감 응답이 더 빠르다.

현재 구현은 Telegram transcript에서 답변을 가져오지 않으며, 별도 실행이므로
Telegram에서 같은 질문을 했을 때와 답변 내용도 달라질 수 있다.

## Non-Goals

- Telegram Bot API를 통해 봇이 자기 자신에게 메시지를 보내지 않는다.
- 사용자 Telegram 계정의 MTProto session이나 개인 인증정보를 추가하지 않는다.
- 데스크톱 질문 또는 답변을 Telegram 채팅에 미러링하지 않는다.
- 벡터 검색 결과를 큐레이터 prompt에 주입하지 않는다.
- 데스크톱 위키 Q&A에서 외부 전송·게시·구매·삭제 도구를 허용하지 않는다.
- 캘린더 AI, Work Conversation, 다른 Responsible Agent의 실행 경로는 변경하지 않는다.

## Alternatives Considered

### A. Hermes Gateway 내부 Session Turn module — selected

현재 Telegram session key와 session ID를 Gateway 내부에서 해석하고 동일 runner에
turn을 주입한다. 출력은 Telegram adapter 대신 capture adapter로 보낸다.

- 장점: transcript, model override, 큐레이터 정책, 동시성 규칙이 Telegram과 동일하다.
- 장점: 새 process spawn과 종료 대기를 제거하고 첫 token부터 스트리밍할 수 있다.
- 장점: session/chat ID를 Railway나 데스크톱에 노출하지 않는다.
- 비용: Hermes Gateway에 명시적인 session-turn seam을 추가해야 한다.

### B. 기존 Hermes API session chat endpoint 재사용

현재 Telegram session ID를 `/api/sessions/{id}/chat/stream`에 전달한다.

- 장점: 이미 SSE와 session ID continuation을 지원해 구현량이 작다.
- 단점: API Server는 별도 agent 생성 경로와 toolset을 사용하므로 Telegram Gateway의
  live model override, cached agent, busy queue와 동작이 달라질 수 있다.
- 결론: 빠른 prototype에는 적합하지만 “Telegram과 동일한 세션 실행” 계약을
  충분히 보장하지 못해 선택하지 않는다.

### C. Telegram 네트워크 왕복

사용자 계정으로 봇에게 질문을 전송한 뒤 Bot API update에서 답변을 읽는다.

- 장점: Telegram 화면과 완전히 동일한 메시지를 보게 된다.
- 단점: 봇은 Bot API `sendMessage`로 자기 자신에게 사용자 입력을 만들 수 없으므로
  사용자 MTProto 인증이 필요하다.
- 단점: Telegram 네트워크 왕복, 개인 session credential, 중복 UI 메시지와 polling
  충돌을 추가한다.
- 결론: 속도·보안·운영 안정성 모두 목표에 맞지 않아 제외한다.

## Architecture

### 1. Session Turn module

Hermes Gateway 안에 하나의 깊은 `SessionTurn` module을 둔다. Interface는 profile과
source alias로 현재 session을 선택하고 하나의 turn event stream을 반환한다.
session lookup, model/provider pinning, transcript continuation, busy handling, agent
execution, cancellation, sanitization은 implementation 안에 숨긴다.

```ts
turn({
  profile: "wikicurator",
  source: "telegram",
  message: string,
  requestId: string,
  delivery: "capture",
  policy: "wiki-read-only"
}): AsyncIterable<SessionTurnEvent>
```

`SessionTurnEvent`는 아래 다섯 종류만 외부에 노출한다.

- `accepted`: request ID, opaque session version, 실제 provider/model
- `delta`: 순서 번호와 새 assistant text 조각
- `tool-status`: 사용자에게 안전한 큐레이터 검색 상태만 선택적으로 제공
- `completed`: 최종 text, provider/model, session version
- `failed`: 안정적인 error code, retry 가능 여부

Raw Telegram chat ID, session ID, prompt, token, tool argument, runtime log는 Interface에
포함하지 않는다.

### 2. Capture adapter

`delivery: capture`는 Telegram adapter와 별개의 실제 두 번째 Adapter다. 같은
Session Turn Interface를 사용하지만 assistant output을 Telegram으로 보내지 않고
Relay event로 변환한다. 이 Adapter 때문에 seam은 가상의 추상화가 아니라 production
동작과 test 동작이 교체 가능한 실제 seam이 된다.

### 3. Mac mini Relay adapter

Relay bridge는 새 job kind `session.turn`을 처리한다.

- `profile=wikicurator`, `source=telegram`만 초기 rollout에서 허용한다.
- current session을 서버 측에서 해석하고 accepted 시점의 session ID와 model을 pin한다.
- Hermes의 delta를 기다리지 않고 즉시 Railway callback event로 전달한다.
- `completed` 전송은 child process 종료에 의존하지 않는다.
- 같은 request ID 재시도는 기존 실행 또는 완료 결과를 replay한다.

### 4. Railway Wiki Turn Orchestrator

`/api/chat/stream`의 `view=wiki` 경로는 질문을 검증한 뒤 두 작업을 병렬 시작한다.

1. `session.turn`: 질문 원문을 그대로 큐레이터 session에 전달한다.
2. `wiki.search`: 같은 질문으로 벡터 근거를 검색한다.

Railway는 Session Turn event를 데스크톱 SSE로 즉시 전달한다. 벡터 검색이 끝나면
별도 `evidence` event로 근거를 추가한다. 두 작업이 끝나면 `done`을 보낸다.
검색 지연은 첫 token 표시를 막지 않는다.

### 5. Desktop stream consumer

데스크톱은 기존 질문 화면을 유지하되 event 의미를 명확히 분리한다.

- `accepted`: “위키 큐레이터 연결됨” 상태
- `delta`: 누적하지 않은 새 조각을 순서대로 append
- `evidence`: 근거 위키 버튼 갱신
- `completed`: streaming indicator 종료
- `failed`: 부분 답변이 있으면 부분 답변과 실패 상태를 함께 표시

실제 provider/model은 진단 metadata로 유지하고 사용자 화면의 Responsible Agent는
`wiki-curator`로 표시한다.

## End-to-End Data Flow

1. 사용자가 데스크톱에서 질문을 제출한다.
2. Desktop은 질문과 client request ID를 Railway에 보낸다.
3. Railway는 `session.turn`과 `wiki.search`를 병렬 enqueue한다.
4. Mac mini bridge는 최신 Telegram `wikicurator` session을 resolve한다.
5. Session Turn module은 해당 session의 transcript와 model override를 pin한다.
6. 같은 Gateway runner가 질문을 처리하고 token delta를 capture adapter로 보낸다.
7. Bridge와 Railway는 delta를 즉시 relay하고 Desktop은 바로 렌더링한다.
8. 벡터 검색이 끝나면 근거 위키 태그가 독립적으로 추가된다.
9. 최종 답변은 동일 Telegram session transcript에 저장된다.
10. Telegram 화면에는 해당 질문과 답변이 전송되지 않는다.

## Session Semantics

- 매 turn 시작 시 최신 active Telegram session을 resolve한다.
- turn이 accepted 된 뒤 `/model` 또는 `/new`가 실행되어도 진행 중 turn은 pin된
  session/model로 끝낸다. 다음 turn부터 새 상태를 사용한다.
- Desktop turn도 동일 transcript에 기록된다. 따라서 다음 Telegram 질문은 Telegram
  화면에 보이지 않았던 Desktop 대화를 문맥으로 기억할 수 있다. 이는 선택된
  “문맥 공유 + Desktop 전용 표시” 동작의 의도된 결과다.
- session이 없으면 새 session을 몰래 만들지 않고 `curator_session_unavailable`로
  실패한다.

## Concurrency and Idempotency

- session당 동시에 하나의 active turn만 허용한다.
- Telegram turn이 실행 중이면 Desktop turn은 기존 Gateway busy 규칙에 따라 FIFO로
  최대 한 건만 대기한다. 두 번째 대기 요청부터 `curator_busy`로 실패한다. UI에는
  `queued` 상태를 표시한다.
- 같은 `requestId`는 질문 문자열까지 일치할 때만 기존 실행/결과를 replay한다.
- 같은 `requestId`에 다른 질문이 오면 `idempotency_conflict`로 실패한다.
- Desktop 연결이 끊겨도 accepted turn은 끝까지 수행하고 결과를 짧은 TTL 동안
  보관한다. 완료 결과 TTL은 10분이며, 재연결은 같은 request ID로 stream을 이어 받는다.

## Safety and Privacy

- Railway caller auth와 Relay bridge auth를 모두 통과해야 한다.
- 데스크톱은 profile/source alias만 보낸다. chat ID와 session ID 선택권은 없다.
- `wiki-read-only` policy는 외부 메시지, 게시, 구매, 거래, 삭제, 설정 변경을 막는다.
- 질문 원문은 session transcript에 저장되지만 public gateway log에는 기록하지 않는다.
- 이벤트 metadata에는 provider/model과 opaque request ID만 허용한다.
- Telegram bot token과 owner chat ID는 기존 Mac mini runtime 밖으로 나오지 않는다.

## Error Handling

- `curator_session_unavailable`: Telegram에서 큐레이터 session을 한 번 연 뒤 재시도 안내
- `curator_busy`: queue가 가득 찼을 때 retry 가능 상태
- `provider_rate_limited`: 부분 답변 보존, retry 가능 상태
- `session_changed`: accepted 전 session 교체 경합 시 한 번 재-resolve
- `relay_disconnected`: request ID로 재연결 가능, 중복 provider call 금지
- `evidence_unavailable`: 자연어 답변은 유지하고 근거 검색 실패를 별도 표시
- hard timeout: 90초. timeout 후 검색 원문을 큐레이터 답변으로 위장하지 않는다.

## Performance Budget

- Railway accepted event: 요청 후 1초 이내
- session resolve와 runner dispatch: 1초 이내
- 첫 assistant delta: 정상 provider 상태에서 p95 30초 이내
- 마지막 provider token부터 Desktop completed 표시: 2초 이내
- 벡터 검색은 첫 delta critical path에 포함하지 않는다.
- 새 Hermes mission/process spawn과 process-exit wait는 0회

## Observability

각 turn은 답변이나 개인정보 없이 다음 timing만 기록한다.

- accepted latency
- session resolve latency
- provider first-token latency
- final-token latency
- Relay delivery latency
- evidence latency
- queue wait와 stable terminal code

운영 상태는 최근 p50/p95 first-token latency와 실패율만 공개 projection에 포함한다.

## Test Strategy

### Hermes Session Turn Interface

- in-memory capture adapter로 동일 session ID와 model override 사용을 검증한다.
- Telegram adapter가 호출되지 않음을 검증한다.
- transcript에 user/assistant turn이 정확히 한 번 기록됨을 검증한다.
- concurrent Telegram/Desktop turn의 FIFO와 busy limit을 검증한다.
- `/model`, `/new`, disconnect, retry 경합을 고정 clock으로 검증한다.

### Mac mini Relay contract

- 질문 원문 외 검색 본문이나 system prompt가 payload에 추가되지 않는다.
- delta sequence, completed, failed가 terminal event 하나로 끝난다.
- 첫 delta callback이 process 종료보다 먼저 전달된다.
- request ID replay는 provider 실행을 중복 생성하지 않는다.

### Railway and Desktop

- `session.turn`과 `wiki.search`가 병렬 시작됨을 검증한다.
- answer delta가 evidence 완료 전에도 UI에 표시됨을 검증한다.
- 근거 버튼이 실제 위키 문서를 열고 중복 source를 제거함을 검증한다.
- 실패 시 raw 검색 문장이 자연어 답변으로 렌더링되지 않음을 검증한다.

### Live acceptance

1. Telegram `wikicurator`에서 OpenAI 모델을 선택한다.
2. server-side test adapter가 선택한 Telegram session을 확인하고, public stream에는
   opaque session version과 실제 model만 노출되는지 확인한다.
3. Desktop에서 nonce가 포함된 위키 질문을 한 번 보낸다.
4. 첫 token이 30초 안에 보이고 자연어 답변이 streaming 되는지 확인한다.
5. completion metadata의 model이 Telegram 선택과 같은지 확인한다.
6. Telegram에 새 질문/답변 메시지가 생기지 않았는지 확인한다.
7. 다음 Telegram 질문이 Desktop turn 문맥을 이어받는지 확인한다.
8. 근거 위키 버튼을 열어 실제 문서 연결을 확인한다.

## Rollout and Rollback

- `HERMES_WIKI_SESSION_TURN_ENABLED` feature flag로 한 사용자에게 먼저 활성화한다.
- 초기 rollout 동안 current `profile.chat` 경로는 코드에 남기되 자동 fallback으로
  사용하지 않는다. session-turn 실패를 old slow path로 숨기지 않는다.
- 문제가 생기면 flag를 끄고 간결한 실패 안내와 근거 위키만 제공한다.
- live acceptance가 두 번 연속 통과하면 rollout을 시작한다. 이후 20회 live turn에서
  p95 first-token이 30초 이내임을 확인한 뒤 old wiki `profile.chat` route 제거를
  별도 cleanup commit으로 진행한다.

## Acceptance Criteria

- Desktop 질문은 현재 Telegram `wikicurator` session transcript에 정확히 한 번 추가된다.
- Telegram에서 선택한 실제 provider/model과 동일한 route로 실행된다.
- 질문과 답변은 Telegram UI에 전송되지 않는다.
- 자연어 답변이 첫 token부터 Desktop에 표시된다.
- 정상 provider 상태에서 첫 token p95가 30초 이내다.
- 벡터 근거가 별도 태그로 표시되고 실제 위키 문서를 연다.
- 외부 side effect 도구는 Desktop 위키 turn에서 실행되지 않는다.
- disconnect/retry가 중복 답변이나 중복 transcript를 만들지 않는다.
- 모든 terminal path가 `completed` 또는 stable `failed` 하나로 끝난다.

## Remaining Risks

- Telegram 화면에 보이지 않는 Desktop turn이 같은 transcript에 남으므로 Telegram에서
  문맥이 갑자기 이어진 것처럼 느껴질 수 있다. 이는 사용자가 선택한 동작이며,
  추후 session activity 표시가 필요할 수 있다.
- Hermes upstream update가 Session Turn seam을 덮어쓸 수 있다. runtime patch만 두지
  말고 Hermes source repository와 배포 절차에 함께 반영해야 한다.
- provider 자체가 느리거나 rate limit이면 30초 목표를 지킬 수 없다. first-token,
  provider latency, Relay latency를 분리 측정해 앱 지연과 provider 지연을 구분한다.
