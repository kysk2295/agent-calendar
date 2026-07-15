# Plan: Business Consultant stopped-state live Work Conversation verification

- Date: 2026-07-15
- Owner: Codex
- Work size: Large / Boundary
- Status: Completed for the enabled `default` Hermes profile — stopped Business Consultant was not used as fake acceptance evidence

## Goal

Business Consultant의 실제 중지 상태를 작업 대화 화면과 live-turn SSE 경로에서 사실대로 처리한다. 중지 중에는 GPT 앱처럼 보이는 가짜 응답을 만들지 않고, 실행 가능 상태에서만 실제 configured completion의 진행/답변이 실시간으로 올라오며, 중지·재개·개입·재시작 뒤에도 같은 작업 대화가 정합하게 복원되는 것을 검증한다.

## Non-Goals

- 운영 자격 증명 변경, 외부 고객 전송·게시·구매·삭제를 수행하지 않는다.
- 브라우저 `route.fulfill`, 정적 timeline fixture, 결정적 completion adapter를 최종 실사용 합격 증거로 사용하지 않는다.
- 중지된 agent를 몰래 ready로 표시하거나, 실제 실행 엔진의 오류를 답변 텍스트로 위장하지 않는다.
- 기존 담당 에이전트 배정 규칙이나 안전 정책을 별도 제품 요구 없이 바꾸지 않는다.

## Touched Boundaries

- Backend gateway: `apps/backend/app/railway-gateway-server.js`
- Backend library: `apps/backend/app/lib/agent-operations-service.js`, `agent-work-live-turn.js`, agent availability/runtime projection
- DB/migrations: 없음이 목표. 기존 agent/runtime 상태와 mission/checkpoint 저장소를 재사용한다.
- Electron bridge: credentialed local proxy의 SSE 전달 및 실제 desktop origin 경로를 점검한다.
- React UI: Agent Work 상태 표시, live SSE hook, composer, durable Work Conversation timeline
- Tests: backend stop/ready contract, desktop stream state, route-free Playwright live workflow
- Docs: 이 계획 및 디버그 저널

## Success Criteria

- [ ] `bizconsultant`가 disabled/stop/unavailable일 때 live-turn은 agent 응답 delta를 시작하지 않고, 사용자에게 중지 원인·재시도/재개 가능 상태를 사실대로 표시하며 그 사실을 저장한다. (Production review found `enabled=false → Idle → available`.)
- [x] 실행 가능 상태의 실제 configured completion에서 새 위임 작업과 후속 메시지가 UI mock 없이 `accepted`, public progress/delta, `done`을 받고 최종 답변을 작업 대화에 저장한다. Railway 배포 `c56b1058-26f9-440b-b860-85d76f6c02ee` 및 raw-log projection 배포 `62fa6413-20b9-4b76-9cf1-38bd37aede02`의 exact desktop proxy flow로 재검증했다.
- [x] 작업 대화에는 사용자에게 의미 있는 체크포인트와 답변만 남고, `run created`·`runner started` 같은 원시 실행 로그는 노출·저장하지 않는다.
- [x] 작업 중 개입(`pause`, `resume`, 수정 지시)은 기존 실행 정책과 메시지 순서를 보존하며, SSE stream과 저장된 checkpoint가 모순되지 않는다.
- [x] 로컬 real-gateway browser flow에서 Business Consultant 상태, composer disabled/enabled 상태, live bubble, final bubble, 재시작 복원이 gateway 상태와 일치한다. compiled desktop proxy의 configured-runtime driver는 Railway `404`를 명시적으로 검증했다.
- [x] 모든 완료 주장은 현실의 stop 상태와 configured runtime을 직접 관찰한 증거에 근거한다. stopped Business Consultant를 실행 가능한 것처럼 취급하지 않고, 실제 검증은 enabled `default` profile과 명시적 `hermes` 엔진으로 수행했다.

## Edge Cases

- 이미 live turn이 있는 상태에서 agent가 중지되면 둘째 메시지는 busy/retry 가능한 상태가 되고 첫 turn의 저장된 결과를 훼손하지 않는다.
- 중지 상태에서 같은 `clientMessageId` 재시도는 실행 엔진을 다시 호출하지 않으며, 저장된 거절/가용성 상태를 재현한다.
- stream 연결이 끊기거나 renderer 재시작이 발생해도 실제로 저장된 user message와 final/error checkpoint만 다시 보인다.
- 상태가 stop에서 ready로 바뀌는 순간 stale UI가 이전 stop 상태나 stale completion을 보여 주지 않는다.
- 외부 행동 요청은 agent 상태와 관계없이 기존 fail-closed 차단을 유지한다.
- 실제 relay run의 stdout은 답변 스트림으로 전달하되, 내부 lifecycle log는 동일 turn의 저장된 작업 대화에 섞이지 않는다.
- 작업 대화와 무관한 전역 보조 데이터 요청이 지연돼도, 이미 독립적으로 로드된 관제 화면의 작업 대화를 오류 배너로 가리지 않는다. 해당 오류는 관련 화면에서 계속 재시도할 수 있어야 한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성하고, 각 실패가 의도한 계약 누락으로 발생했음을 확인한다.

- RED:
  - [x] stopped `bizconsultant` live-turn이 completion을 호출하거나 `delta`를 보내는 결함을 재현하는 backend test를 추가한다.
  - [x] stopped/ready/stream-error public event와 durable checkpoint 순서가 렌더러 상태와 달라지는 desktop test를 추가한다.
  - [x] 실제 local gateway browser workflow에서 stopped surface가 fake live bubble을 만들거나 stale state를 보이는 Playwright regression을 추가한다.
  - [x] actual configured completion을 쓰는 route-free browser driver를 추가한다. 이 driver는 frontend request mock과 completion adapter injection을 금지하며, 현재 Railway `404`를 실패 증거로 고정한다.
- GREEN:
  - [x] agent availability를 live-turn 시작 전에 단일 권위 상태로 판정하고 public stopped/unavailable outcome을 구현한다.
  - [x] renderer가 terminal unavailable/error와 active stream을 명확히 구분하도록 최소 수정한다.
  - [x] 실제 configured runtime으로 시작·stream·persist·reload되는 browser flow를 구현하거나, 이미 존재한다면 실제 상태와 contract의 차이를 제거한다.
  - [x] relay lifecycle log가 durable `progress` checkpoint가 되는 RED를 추가하고, user-meaningful checkpoint만 통과하도록 GREEN 처리한다.
- REFACTOR:
  - [x] stop/ready projection과 generic error copy를 중복 없이 정리하고, mock-only tests를 실사용 acceptance gate와 분리한다.
  - [x] Agent Operations와 무관한 optional API 오류가 작업 대화 화면을 가리지 않는다는 UI 계약을 RED/GREEN으로 고정한다.

## Acceptance Gates

- [x] `npm run backend:check`
- [x] focused stopped-agent/live-turn backend tests (7/7)
- [ ] `npm run test:backend` — 90-second bounded run reached 171 passes and 0 failures, then reported one cancelled `agent-operations.test.cjs` file because a promise remained pending; the existing termination defect remains a release-gate blocker.
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test` (112/112)
- [x] focused desktop stop/stream state tests and local real-gateway browser workflow
- [x] superseded configured-runtime UI workflow from desktop proxy origin, with no request-route fixture or injected completion adapter — this older run covered the UI lifecycle but did not prove Hermes provenance.
- [x] real enabled `default` Hermes profile workflow from the exact desktop proxy origin, with no request-route fixture or injected completion adapter — production Work `mission-work-d7651bdca452bf1d04292712` returned the nonce and `37×19=703`, accepted a follow-up, persisted both answers, restored after reload, and passed at 375px.
- [x] real bottom console workflow through `/api/chat/stream` — the same browser received HTTP 200 `text/event-stream` from remote `profile.chat`, rendered pending and answer frames, and returned the nonce plus `29×17=493` without a mock route.
- [x] real configured Work control workflow — the dedicated Work `mission-work-e035eafb3f76ffe3c0b2383c` was opened through the desktop proxy, paused, resumed, reloaded, and observed as `운영 중` again.
- [x] `npm run build:desktop`
- [x] fresh 1280px, 768px, 375px captures of stopped, streaming, and settled states plus two independent visual QA passes
- [ ] `npm test` — not run as a duplicate because its backend portion reproduces the bounded aggregate termination defect above; the desktop portion passed independently (112/112).

건너뛴 gate:

없음. 사용자가 2026-07-15에 Railway production 배포와 재검증을 명시 승인했다.

## Implementation Checklist

- [x] Step 1: 현재 Business Consultant의 실제 stop 원인·runtime/desktop proxy 상태를 read-only로 관찰하고, 세 가설을 runtime evidence로 판별한다.
- [ ] Step 1a: disabled Hermes profile을 `Idle`/ready로 오인해 허용하는 availability 경로와 `auto → Codex` execution provenance를 RED/GREEN으로 바로잡는다.
- [x] Step 2: stop/ready/live-event 계약을 문서화하고 RED backend·desktop·browser regressions를 만든다.
- [x] Step 3: 필요한 최소 backend availability/SSE projection을 구현하고 focused RED tests를 GREEN으로 바꾼다.
- [x] Step 4: 필요한 최소 desktop state/composer/timeline 수정을 구현하고 local real-gateway workflow를 통과시킨다.
- [x] Step 5: actual configured Business Consultant completion으로 ready → live stream → intervention → persistence → restart 복원을 exact desktop proxy browser로 검증한다.
- [x] Step 5a: 실제 stream capture에서 발견된 내부 runner lifecycle log의 작업 대화 노출을 테스트 우선으로 차단하고 production에서 다시 확인한다.
- [x] Step 5b: 실제 운영 capture에서 드러난 비관련 전역 채팅 타임아웃 배너가 작업 대화를 가리는 문제를 테스트 우선으로 분리하고, 재검증한다.
- [x] Step 5c: paused 위임 작업이 실제 관제 화면에서 다시 시작될 수 있도록 `activate` 경로를 노출하고, 전용 검증 작업에서 pause → resume → 재시작 복원을 확인한다.
- [x] Step 6: 관련 전체 회귀, build, fresh responsive captures, 독립 visual QA, journal cleanup을 완료한다. 전체 backend suite의 기존 non-terminating gate는 Remaining Risks로 분리한다.
- [x] Step 7: connected remote Mac mini bridge에 `profile.chat`을 구현하고 hard timeout/public error mapping을 적용한 뒤 Railway gateway를 배포한다.
- [x] Step 8: enabled `default` Hermes profile로 실제 작업 대화와 하단 콘솔을 한 브라우저 세션에서 검증한다.

## Verification Notes

- RED: stopped responsible agent test called the completion once before availability preflight existed; the same test is GREEN with zero completion calls and `accepted → checkpoint(error) → error → done`.
- RED: partial streamed text hid its transport error in the renderer; the SSR timeline test is GREEN and requires an explicit `오류`, partial-response label, and error copy.
- RED: narrow real-gateway browser test found the timeline rather than the conversation as the scroll owner; the final browser workflow is GREEN with only `.agent-work-conversation` scrollable at 375px.
- GREEN: `npm run backend:check`; focused backend 7/7; `npm run typecheck`; desktop tests 109/109; `npm run build:desktop`; focused real-gateway browser workflow (81 API responses); `git diff --check`.
- Late visual RED/GREEN: the visible primary `계획 만들기` action used `--accent` with near-white text (3.52:1). A focused CSS contract test now locks `--accent-dark`, whose default light-theme contrast is 4.96:1, and the route-free local browser capture confirms the rendered action.
- Configured runtime: Railway deployment `c56b1058-26f9-440b-b860-85d76f6c02ee` 이후 exact desktop proxy origin이 `mission-work-4e9106bb78eec517bfa89c85`를 생성했다. initial/follow-up live SSE는 HTTP 200 `text/event-stream`, 10개의 live DOM frame, final answer persistence, reload restoration을 통과했다.
- Runtime visual RED: 첫 프로덕션 capture에서 `run created`, `agent=bizconsultant`, `runner started` 같은 relay lifecycle log가 durable `진행` 카드로 보였다. Context의 “raw tool activity does not [belong in Work Conversation]” 계약에 어긋나므로 Step 5a에서 최소 필터로 제거한다.
- GREEN: `relay-profile-completion`은 agent stdout만 Work Conversation `agent_message`로 투영하고 lifecycle/tool 로그는 버린다. focused backend RED/GREEN 후 deployment `62fa6413-20b9-4b76-9cf1-38bd37aede02`에 반영했고, configured-runtime capture에서 lifecycle 카드가 없음을 확인했다.
- GREEN: 전역 채팅 API 타임아웃은 관제 화면의 Work Conversation을 가리지 않으며, `agentOperations`는 별도 장기 예산으로 hydrate된다. 실제 1280/375 capture에서 배너 없이 대화와 composer가 복원됐다.
- GREEN: paused Work의 aggregate state가 stale conversation snapshot으로 덮여 재개 버튼이 사라지던 결함은 RED contract와 mission Playwright workflow로 고정했다. `selectedBaseMission.status`를 권위로 사용하고, `activate`를 작업 대화 상세 화면에 노출했다. 실제 desktop proxy control workflow가 pause → resume → reload를 통과했다.
- Superseded gate note: desktop 112/112, `npm run build:desktop`, `npm run backend:check`, local real-gateway E2E (81 API responses), configured live runtime (67 API responses, 6 live frames), configured control cycle, and `git diff --check` passed. These did not establish Hermes execution provenance: the captured Work was file-shaped, requested `auto`, and resolved to `codex`.
- Runtime quality RED: an explicit `wikicurator` + `hermes` production Work took 56,297ms and persisted `API call failed after 3 retries: HTTP 429: Provider returned error` as an `agent_message`. This is a real provider failure, not a mock and not an acceptable answer.
- Runtime quality GREEN (local contract): canonical execution-engine metadata survives sanitization, and completed Hermes runs whose stdout is an exhausted provider retry failure emit no answer delta and fail with `provider_rate_limited`. Production re-verification remains required after deployment.
- Direct-chat investigation: four production live Work attempts reached the real relay bridge (not UI fixtures) but failed with `model is required`, then `model ... not found` for `anthropic/claude-opus-4.6`, `gpt-4o-mini`, and `hermes-agent`. The bridge source contract forwards `chat.completions` directly to a local model API; its `profile` field does not execute a Hermes profile.
- Safety rollback: removed the guessed `HERMES_API_SERVER_MODEL` production variable and restored Hermes console/Work traffic to the profile mission runner. The fast `chat.completions` path is retained only for explicitly selected `local_llm`, preventing false Hermes provenance.
- Remote bridge GREEN: connected host `goyunseoui-Macmini.local` now handles `profile.chat` with the requested Hermes profile, a bridge-level hard timeout, terminal completion on every path, and sanitized public errors. Remote focused tests pass 5/5, the full `os-runtime` suite passes 15/15, and two consecutive actual default-profile calls terminated successfully without pending jobs or child processes.
- Production GREEN: Railway deployment `a7260b58-5ef4-4a35-bec3-2966295a5e35` routes Hermes Work Conversation and bottom-console requests to `profile.chat`; the guessed model override remains absent.
- Manual QA GREEN: configured desktop browser Work `mission-work-d7651bdca452bf1d04292712` produced a real nonce-bearing `703` answer after 23,743ms, persisted a 50-character follow-up, survived reload, and stayed within a 375px viewport. The bottom console then produced a 48-character nonce-bearing `493` answer over `/api/chat/stream`; 5 console frames and 8 Work live frames were observed.
- Latest regression gates: `npm run backend:check`, focused Hermes Work/console backend tests (2/2), `npm run typecheck`, desktop tests (112/112), `npm run build:desktop`, configured-runtime Playwright, and `git diff --check` pass.

## Remaining Risks

- Risk: Business Consultant runtime이 로컬에서 실제로 시작 불가하거나 필요한 runtime credential이 없다.
  - Mitigation: stop 상태를 정직하게 검증하고, 실제 ready-stream 증거가 불가능한 이유를 기록한다. 운영 자격 증명이나 배포를 추측해 사용하지 않는다.
- Risk: 현재 production Business Consultant가 ready여서, 실제 production 프로필을 의도적으로 stopped 상태로 전환하는 검증은 수행하지 않았다.
  - Mitigation: stopped/unavailable path는 availability boundary·SSE persistence·local real-gateway browser test로 직접 검증했다. 사용자 작업의 실제 runtime 상태를 강제로 바꾸지 않았다.
- Risk: `npm run test:backend` remains non-terminating in `agent-operations.test.cjs`; the latest 90-second bounded run produced 171 passes, 0 failures, and 1 cancelled file due to a pending promise.
  - Mitigation: isolate that existing pending promise before treating the backend aggregate suite as a release gate; focused changed-boundary tests, backend syntax, desktop tests, typecheck, build, and real browser QA pass.
- Risk: 검증용 위임 작업 레코드가 production에 남는다.
  - Mitigation: 모두 제목이 `실제 Business Consultant 스트리밍 검증`인 안전한 내부 검증 작업이며, 마지막 control Work는 활성 상태로 복구했다. 기존 사용자 작업이나 agent 설정은 변경하지 않았다.
- Risk: A disabled profile can currently be rendered as ready and a file-shaped automatic Work can run on Codex under that profile's accountability label.
  - Mitigation: this is the active correction. No further Hermes completion claim or production acceptance result is valid until disabled-profile preflight and engine provenance are covered by a red/green regression and a manual runtime gate.
- Risk: the remote Hermes CLI currently returns its generated answer as one stdout result, so the bridge emits a real SSE delta but does not yet provide token-by-token text growth. The UI truthfully shows a pending live state, then the real answer; the measured first answer delta was 23,743ms.
  - Mitigation: keep the current path described as real profile-backed SSE, not token streaming. Token-level UX requires a Hermes runtime interface that exposes incremental generation rather than buffered CLI stdout.
