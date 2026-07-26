# Plan: Unified cross-channel Work Conversation

- Date: 2026-07-26
- Owner: Codex
- Work size: Large / Boundary
- Status: In progress — production completion pass
- Parent PRD: `docs/PRD-agent-calendar-agent-platform-additions.md`
- Replaces session cardinality in:
  `docs/plans/2026-07-25-provider-native-agent-session-bridge.md`

## 2026-07-26 Production Completion Pass

사용자 요청에 따라 기존 구현과 검증 주장을 처음부터 다시 감사하고 다음 다섯 항목을
하나의 production completion gate로 닫는다.

1. 현재 변경분을 기능 경계별로 재검토하고 검증 가능한 커밋 준비 상태로 정리한다.
2. 실제 Codex → Claude → Codex 전환이 하나의 canonical Work Conversation과 정확한
   provider session continuity를 유지하는지 다시 관찰한다.
3. 서로 다른 실제 provider account identity를 사용하는 두 Workspace/Runner가
   endpoint, session, event, artifact, cursor를 상호 열거하거나 실행하지 못하는지
   fail-closed ETE로 검증한다.
4. Railway production `hermes-os`에 존재하는 기존 Telegram credential 변수는 값을
   출력·기록하지 않고 Runner-local 0600 credential store로 안전하게 이관한 뒤,
   Desktop ↔ Telegram 실제 왕복과 replay/restart를 관찰한다. 기존 Gateway 변수 제거는
   live 경로 전환과 rollback 증거 뒤 별도 명시적 파기 단계로 남긴다.
5. 기본 단일 엔진 실행은 그대로 보존하면서, 사용자가 명시적으로 선택한 경우에만
   여러 engine endpoint가 동일한 canonical user turn을 비교 실행하고 각 응답의
   engine/model/session origin을 표시하도록 구현한다.

추가 시각 품질 gate:

- Work Checkpoint는 성공색 테두리나 중첩 카드로 상태를 장식하지 않는다.
- 같은 실행의 진행·도구·산출물 checkpoint는 한 실행 묶음으로 압축하고, 최종 응답을
  먼저 읽게 하며 세부 실행 기록은 사용자가 펼칠 때만 노출한다.
- 실행 엔진 비교는 엔진별 결과 묶음이 얇은 구분선과 타이포그래피 위계로 구분되어야
  하며, 원시 runtime 이벤트가 대화의 주 콘텐츠처럼 반복되어서는 안 된다.

완료 조건은 자동 테스트 통과만이 아니다. 실제 Desktop surface, 실제 provider CLI,
실제 Telegram delivery에서 같은 canonical sequence와 current result를 관찰하고
민감정보가 Gateway DB·로그·evidence·응답에 포함되지 않았음을 확인해야 한다.

## Goal

사용자가 Codex, Claude, Agent Calendar Desktop, Telegram 중 어디에서 대화를 이어도 하나의
Work Conversation에 같은 사용자 메시지, 에이전트 답변, checkpoint, artifact, 승인,
오류, Calendar 결과가 같은 순서로 보이게 한다.

Work Conversation이 유일한 대화 원본이다. Codex/Claude/Hermes/Grok provider session과
Telegram 같은 채널은 이 원본에 연결된 endpoint다. 실행 엔진을 바꿔도 새 대화를 만들지
않으며, 각 endpoint가 받은 마지막 canonical event와 전달한 결과를 내구성 있게 추적한다.

## Non-Goals

- Provider의 비공식 로컬 history 파일에 메시지를 직접 삽입하거나 수정하지 않는다.
- Codex/Claude 공식 앱이 지원하지 않는 transcript import를 지원한다고 표시하지 않는다.
- 모든 메시지를 모든 모델에 자동 실행하지 않는다.
- Telegram의 기존 전역 env bot routing을 다중사용자 제품 경로로 재사용하지 않는다.
- Mobile은 Desktop/Web production gate 전에 구현하지 않는다.
- 이번 첫 slice에서 Slack, Teams, Discord를 추가하지 않는다.

## Touched Boundaries

- Backend gateway:
  - Work Conversation message API의 target endpoint/engine 선택
  - Runner-local Telegram endpoint ingress/egress
- Backend library:
  - canonical event append, endpoint binding, delivery cursor, idempotency
  - provider endpoint 선택과 explicit fan-out
- DB/migrations:
  - Work Conversation당 여러 provider session 허용
  - channel endpoint와 delivery receipt
  - Workspace composite FK, FORCE RLS
- Electron bridge:
  - 변경 없음
- React UI:
  - Work Conversation의 active engine 선택
  - 메시지 origin/engine/channel 표시
  - endpoint 상태와 delivery 상태
- Runner:
  - provider session별 exact resume
  - Telegram local credential 및 opaque binding
- Tests:
  - backend hostile isolation/concurrency/restart
  - Runner endpoint routing
  - Desktop same-transcript UX
  - actual Codex + Claude + Telegram ETE
- Docs:
  - PRD, provider session bridge correction, verification evidence

## Product Contract

### Telegram user flow

- Work Conversation 화면에서 사용자는 이 기능을 "같은 위임 작업을 Telegram에서 이어가는
  연결"로 이해할 수 있어야 한다.
- 연결 전에는 토큰을 Desktop이나 Gateway에 입력하지 않는다. 화면은 Runner 호스트에서
  실행할 토큰 없는 설정 명령만 제공하고, Bot token과 chat id가 Runner에만 저장된다는
  경계를 명시한다.
- 연결 후에는 Bot 이름이나 chat id 대신 채널 상태, 연결된 Runner, 최근 동기화 시각만
  표시한다.
- `active` endpoint는 "Telegram 연결 성공"이 아니라 "Runner에 등록됨"으로 표시한다.
  Bot API ingress 단독 소유권은 별도 검증 전까지 미확인으로 남긴다.
- 같은 Bot을 기존 Hermes poller가 소유하면 중복 답변과 Telegram 409가 발생할 수 있음을
  연결 전과 연결 후 모두 알린다. 전용 Bot 또는 안전한 poller cutover가 없으면 production
  ingress 준비 완료로 표시하지 않는다.
- 연결 UI는 초록 테두리, 성공색 카드, 중첩 카드 구조를 사용하지 않고 얇은 중립 구분선과
  타이포그래피 위계만 사용한다.

### Canonical conversation

- `agent_session_events`의 Workspace-scoped ordered stream이 사용자에게 보이는 대화 원본이다.
- 모든 inbound 메시지는 먼저 canonical event로 한 번만 저장된다.
- provider 응답, tool/checkpoint, artifact, approval, error, Calendar projection도 같은
  conversation과 turn identity를 가진다.
- endpoint 장애가 canonical history를 삭제하거나 되돌리지 않는다.

### Endpoint bindings

- 하나의 Work Conversation은 0개 이상의 provider endpoint를 가진다.
- 같은 conversation은 Codex endpoint 하나와 Claude endpoint 하나를 동시에 가질 수 있다.
- provider endpoint는 exact Workspace, agent, Runner, engine, external session id를 가진다.
- Telegram endpoint는 Gateway에 bot token/chat id를 저장하지 않는다. Runner가 가진
  opaque local binding handle만 Gateway에 등록한다.
- endpoint마다 inbound/outbound cursor와 delivery receipt를 저장한다.

### Turn routing

- 한 사용자 turn은 정확히 한 active engine으로 전달하는 것이 기본이다.
- engine은 provider 실행기이고 model은 그 실행기가 선택한 추론 모델이다. 둘을 같은
  필드나 같은 라벨로 취급하지 않는다.
- 각 turn은 선택적인 `requestedModel`을 가진다. 값이 없으면 Runner의 현재 기본 모델을
  사용하되 UI에는 `Runner 기본 모델`로 표시하고 특정 모델을 추정하지 않는다.
- Runner가 model catalog를 보고하면 UI는 그 목록만 선택지로 제공한다. catalog를
  제공하지 않는 CLI는 안전한 model id 직접 입력을 허용하며 Runner가 실행 전에 검증한다.
- 실행 결과는 `resolvedModel`을 다시 보고한다. 요청 모델과 실제 모델이 다르면 둘 다
  보존하고 사용자에게 fallback 사실을 표시한다.
- engine comparison이나 회의처럼 명시적 fan-out만 여러 endpoint를 실행한다.
- engine 전환 시 새 provider endpoint가 필요하면 사용자가 전환을 선택한 뒤 만든다.
- 다른 engine은 canonical transcript 또는 bounded context snapshot을 받아 맥락을 이어간다.
- provider가 native transcript import를 지원하지 않으면 Agent Calendar에서는 동일
  canonical history를 보여주되 provider 공식 앱에 동일 원문이 쓰였다고 표시하지 않는다.

### Cross-channel delivery

- Desktop과 Telegram에서 들어온 메시지는 동일한 append API와 idempotency contract를 쓴다.
- origin endpoint는 자기 outbound echo를 다시 inbound로 만들지 않는다.
- 동일 Telegram update, Desktop client message, Runner retry는 canonical event 하나만 만든다.
- endpoint offline은 `delivery_pending`; 복구 뒤 cursor부터 재전달한다.
- 순서가 다른 두 메시지는 server sequence로 직렬화되며 동시 engine turn은 만들지 않는다.

## Success Criteria

- [x] 하나의 Work Conversation에 Codex와 Claude provider session을 함께 연결한다.
- [x] Codex/Claude/Grok/Hermes turn에서 요청 engine과 요청 model을 별도로 저장하고
      Runner lease까지 정확히 전달한다.
- [x] 대화 헤더와 각 실행 결과에서 실제 `resolvedModel`을 확인할 수 있다.
- [x] model catalog가 없는 Runner에 대해 특정 모델을 추정하거나 하드코딩하지 않는다.
- [x] Codex에서 시작한 뒤 Claude로 전환해도 이전 canonical transcript와 artifact가 보인다.
- [x] Claude 응답 뒤 Codex로 돌아가도 같은 Work Conversation에서 다음 turn이 이어진다.
- [x] 기본 메시지는 active engine 하나만 실행하고 다른 engine 실행 횟수는 0이다.
- [x] 명시적 비교 요청만 여러 engine endpoint를 실행하고 각 응답 origin을 표시한다.
- [x] Work Checkpoint가 Orca식 평면 위계로 묶여 결과 우선으로 보이고, 원시 실행
      checkpoint는 접힌 실행 기록에서만 보인다.
- [ ] Desktop과 Telegram에 같은 canonical message sequence와 current result가 보인다.
- [x] Work Conversation 화면에서 Telegram 연결 목적, Runner-local 보안 경계, 등록 상태,
      ingress 소유권 미확인을 사용자가 확인할 수 있다.
- [x] 앱/Gateway/Runner/Telegram endpoint 재시작 뒤 delivery cursor와 provider session을
      복구한다.
- [x] provider 공식 앱에 완전 동일 transcript를 보장할 수 없는 capability를 정직하게
      표시한다.
- [x] User A/B의 endpoint id, provider session id, Telegram binding, message, cursor,
      receipt, artifact가 교차 노출되지 않는다.
- [x] token, cookie, chat id, provider credential이 Gateway DB, logs, evidence, response에
      나타나지 않는다.

## Edge Cases

- 두 endpoint가 동시에 사용자 메시지를 보냄:
  - canonical sequence와 one-active-turn lock으로 직렬화한다.
- Codex active 중 Claude 전환:
  - 현재 turn을 완료/취소/분기하는 명시적 선택 없이는 동시에 실행하지 않는다.
- Claude provider session missing:
  - canonical history는 보존하고 Claude endpoint만 `missing`으로 표시한다.
- Telegram Runner offline:
  - 메시지는 durable pending이며 다른 Workspace Runner로 fallback하지 않는다.
- 동일 provider session을 두 conversation에 연결:
  - scoped conflict로 거부한다.
- Telegram update replay:
  - origin delivery key로 idempotent replay 처리한다.
- provider transcript import 미지원:
  - bounded canonical context로 실행하되 native app mirror capability는 `unsupported`로 표시한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] 기존 1:1 unique constraint가 second provider endpoint를 거부한다.
  - [x] Work Conversation A에 Codex와 Claude를 연결하고 turn별 exact endpoint를 선택한다.
  - [x] active engine 하나만 offer를 받고 foreign/mirror endpoint offer는 0건이다.
  - [x] canonical event가 Desktop/Telegram replay에도 한 번만 저장된다.
  - [x] endpoint cursor/receipt가 restart 뒤 복구된다.
  - [x] cross-Workspace endpoint enumeration과 direct-id access가 404다.
- [x] provider/chat credential-shaped payload가 경계에서 거부된다.
  - [x] requested model은 제한된 공개 identifier만 허용하며 token/cookie 형태는 거부한다.
  - [x] Runner가 보고한 model catalog와 요청 모델의 일치 여부를 same-Workspace에서 검증한다.
- GREEN:
  - [x] provider session 1:N migration과 endpoint selection
  - [x] canonical append/delivery receipt service
  - [x] Desktop active engine control
  - [x] Runner-local Telegram endpoint
- REFACTOR:
  - [ ] provider와 channel adapter의 public endpoint projection을 공통화한다.
  - [ ] 기존 단일 provider query를 explicit active endpoint query로 교체한다.

## Acceptance Gates

- [x] focused backend migration/service tests
- [x] focused Runner endpoint tests
- [x] focused Desktop UX tests
- [x] focused Telegram connection presentation/parser tests
- [x] actual Codex → Claude → Codex one-conversation ETE
- [ ] actual Desktop ↔ Telegram one-conversation ETE
  - [x] actual Telegram Desktop → Runner/Gateway → Codex → Desktop/Telegram product path
  - [x] new bindings start at the current conversation tail and deliver one user-facing result
  - [ ] exclusive ingress ownership cutover from the existing Hermes poller
- [ ] two-account hostile endpoint isolation ETE
  - [x] two AuthKit users / two Workspaces hostile isolation with real Desktop, Gateway,
    Runner, and persisted restart recovery
  - [ ] two distinct real Codex provider accounts
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run runner:check`
- [x] `npm run test:runner`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`

건너뛴 gate:

- Production deployment:
  - isolated staging, WorkOS live tenant, and exact release evidence are separate external gates.

## Implementation Checklist

- [x] Step 1: user-visible shared-conversation semantics and capability honesty
- [x] Step 2: provider session 1:N RED and migration
- [x] Step 3: per-turn active provider endpoint RED/GREEN
- [x] Step 4: Desktop engine switch and canonical origin presentation
- [x] Step 5: live Codex/Claude switch ETE
- [x] Step 5a: requested/resolved model Boundary와 Desktop 선택·표시
- [x] Step 6: Runner-local Telegram binding/delivery RED/GREEN
- [ ] Step 7: Desktop/Telegram live ETE and hostile isolation
- [x] Step 8: full regression, evidence, release gate update
- [x] Step 9: checkpoint 실행 묶음과 결과 우선 Orca식 평면 UI, 실제 화면 QA
- [x] Step 10: Work Conversation의 Telegram 연결·상태·안전한 Runner 설정 UI
- [x] Step 10a: Runner의 Telegram 수신 성공/409를 credential-free 상태로 보고하고
      Work Conversation에 별도 표시
- [x] Step 10b: Gateway의 150초 ingress freshness와 Runner/endpoint 상태를 결합한
      production readiness를 기존 평면 정보 행에 표시

## Rollback

- Migration은 기존 provider session row와 external session identity를 보존한다.
- feature flag를 끄면 기존 conversation의 현재 primary provider endpoint만 사용한다.
- Telegram endpoint를 내려도 canonical history와 provider sessions는 유지한다.
- 새 endpoint row를 삭제하거나 기존 provider session id를 재해석하지 않는다.

## Verification Notes

- Pre-implementation schema audit:
  - `provider_agent_sessions` has `unique (workspace_id, work_conversation_id)`;
  - message follow-up selects one provider row with `limit 1`;
  - existing Telegram routing is global env configuration and not Workspace-owned.
- Implemented verification:
  - real local Codex CLI accepted `gpt-5.6-sol` and returned the expected answer;
  - real local Claude CLI reported `claude-sonnet-4-6` in its execution stream;
  - focused backend ETE switched Codex → Claude → Codex in one canonical conversation;
  - Runner-local Telegram tests observed inbound, outbound, idempotent replay, restart restore,
    0600 local credential storage, and no Gateway chat/token persistence;
- Desktop Playwright evidence:
    `.omo/evidence/agent-work-model-selection.png`.
- Current production build UI evidence:
  - `apps/desktop/test-results/phase3-golden-ete-codex-comparison/explicit-engine-comparison.png`
    shows neutral compact engine toggles and one flat result-first run per engine;
  - `apps/desktop/test-results/phase3-golden-ete-codex/cross-engine-same-conversation.png`
    shows Codex → Claude → Codex continuity in one Work Conversation.
- Current live CLI ETE:
  - explicit Codex + Claude comparison: 3 completed attempts, 0 failed attempts,
    one canonical comparison message, Desktop/backend/Runner restart recovery;
  - Codex → Claude → Codex: 4 completed attempts, 0 failed attempts, original Codex
    provider session restored after the Claude turn.
- Two-Workspace hostile isolation ETE passed with two AuthKit subjects, two Workspaces,
  one independently enrolled Runner per Workspace, three completed jobs per Workspace,
  two inference jobs per Workspace, one calendar event per Workspace, and restart recovery.
  The execution engine was the deterministic fake adapter so this proves product isolation,
  but does not replace the remaining distinct-real-Codex-account gate.
- Full local regression after the production completion pass:
  - backend syntax passed;
  - backend 513/513, Desktop 291/291, Runner 58/58 tests passed;
  - Desktop typecheck and production build passed.
- Railway production Telegram coexistence bootstrap observed five exact bot identities, one
  private allowlisted chat, `existing-poller`, `deliveryReady=true`, zero registered webhooks,
  and empty Bot API webhook URLs before and after the check.
- The real product Telegram report formatter/sender delivered one bounded acceptance report
  from each of the five Responsible Agent bot routes. Bot API confirmed all five private-chat
  deliveries and webhook state remained empty.
- Telegram Desktop live evidence:
  - the Railway `wikicurator` bot received one nonce-bearing user message;
  - Runner/Gateway persisted that message once with `origin=telegram`;
  - the real local Codex CLI completed the same Work Conversation;
  - Desktop displayed the Telegram-origin turn and the Codex result;
  - Agent Calendar acknowledged exactly one outbound receipt and sent one compact final answer;
  - a new channel binding did not replay the pre-bind conversation, and raw Runner/plan/tool/
    artifact lifecycle events were not projected to Telegram.
- The existing Hermes poller also answered the same bot message, and a later strict repeat
  received Telegram Bot API 409 while `getWebhookInfo` remained empty. This proves two
  `getUpdates` owners are competing. The Runner now reports `TELEGRAM_INGRESS_CONFLICT`
  explicitly without reflecting the token, chat id, or Telegram error description.
- Manual evidence:
  - `apps/desktop/test-results/phase3-golden-ete-codex-telegram/telegram-inbound-visible-in-desktop.png`
  - `apps/desktop/test-results/phase3-golden-ete-codex-telegram/telegram-codex-result-visible-in-desktop.png`
  - `apps/desktop/test-results/phase3-golden-ete-codex-telegram/telegram-desktop-live-round-trip.png`
- The runbook requires preserving the current Mac mini poller. No webhook was registered,
  no token was removed, and the remote execution host rejected non-interactive SSH, so a
  safe exclusive-ingress cutover could not be performed from this session.
- Full local regression after the Telegram boundary correction:
  - `npm run backend:check` passed;
  - `npm run runner:check` passed;
  - `npm test` passed, including Backend 513/513, Desktop 292/292, Runner 59/59;
  - the focused Telegram backend and Runner tests passed.
- Telegram connection UI verification:
  - Work Conversation response projects only endpoint id, channel status, Runner id,
    unverified ingress ownership, and last activity time;
  - Desktop parser rejects unknown channel states and exposes no token, chat id, or binding handle;
  - the Work Conversation surface presents a neutral disclosure with a token-free Runner command,
    Runner registration state, and explicit existing-poller warning;
  - mocked Playwright rendered the registered state without sending any Telegram message:
    `apps/desktop/test-results/telegram-continuation-ui/connected-state.png`.
- Telegram ingress ownership visibility:
  - Runner가 `getUpdates` 성공을 `owned`, Bot API 409를 `conflict`로 보고하고 동일 상태의
    반복 쓰기는 60초 동안 제한한다;
  - Gateway는 same-Workspace/same-Runner endpoint만 갱신하고 public response에는
    `unverified | owned | conflict`와 확인 시각만 투영한다;
  - Desktop은 "Runner에 등록됨"과 "수신 확인됨 / 다른 수신 주체와 충돌"을 별도 행으로
    표시하며 새 카드나 성공색 테두리를 추가하지 않는다;
  - 실제 Telegram 메시지 없이 mocked 409를 밝은/어두운 테마에서 수동 확인했다.
- Telegram ingress readiness:
  - Gateway는 한 응답에서 동일한 기준 시각으로 `unverified | ready | conflict | stale`를
    계산하고 malformed timestamp는 `unverified`로 fail closed한다;
  - Desktop strict parser는 ownership/readiness의 불가능한 조합을 거부한다;
  - endpoint가 offline/revoked이거나 Runner가 disconnected면 과거의 fresh `owned`
    관찰만으로 "수신 준비됨"을 표시하지 않는다;
  - Backend 515/515, Desktop 294/294, Runner 60/60 전체 회귀와 production build가
    통과했다;
  - light/dark evidence:
    `apps/desktop/test-results/telegram-ingress-readiness/conflict-light.png`,
    `apps/desktop/test-results/telegram-ingress-readiness/conflict-dark.png`.

## Remaining Risks

- Provider 공식 앱은 외부 transcript append를 지원하지 않을 수 있다. Agent Calendar와
  Telegram의 동일 canonical transcript와 provider execution context continuity를
  보장하고, native app mirror 수준은 capability로 구분해야 한다.
- 여러 엔진에 전체 transcript를 반복 주입하면 비용과 prompt 크기가 커질 수 있다.
  endpoint별 cursor 기반 bounded context snapshot이 필요하다.
- 두 로컬 Codex home은 경로는 분리됐지만 같은 실제 account identity로 확인되어 strict
  two-account ETE를 실행할 수 없다. 별도 Codex 계정을 두 번째 home에 인증해야 한다.
- 기존 Telegram token은 Mac mini poller가 실제 ingress를 소유하므로 Railway에서 제거하거나
  Runner poller로 절체하지 않았다. 실제 product path는 검증됐지만, 기존 poller의 중복 응답과
  Bot API 409도 관찰됐다. 원격 poller를 중지하고 Runner를 단독 owner로 만든 뒤 rollback을
  관찰하거나, Agent Calendar 전용 bot을 발급해야 production ingress gate가 닫힌다.
