# Plan: Agent Work live conversation

- Date: 2026-07-15
- Owner: Codex
- Work size: Large / Boundary
- Status: Completed

## Goal

Agent Work를 목 응답을 나열하는 화면이 아니라, 사용자가 실제 실행 엔진에 메시지를 보내면 저장 확인 직후 토큰/진행 이벤트를 실시간으로 받고, 완료된 답변을 같은 작업 대화에 영속적으로 다시 열 수 있는 대화형 작업 공간으로 만든다.

## Non-Goals

- Railway 운영 환경을 이 작업 중 배포하거나 운영 토큰·데이터를 변경하지 않는다.
- 외부 전송·게시·구매·삭제 권한을 추가하지 않는다. 기존 fail-closed 정책은 그대로 적용한다.
- 기존 Task Session/legacy mission route를 이번 변경에서 제거하거나 데이터 마이그레이션하지 않는다.
- 모델의 비공개 추론, raw tool input, 자격 증명, 내부 경로를 스트림이나 타임라인에 노출하지 않는다.

## Touched Boundaries

- Backend gateway: `apps/backend/app/railway-gateway-server.js`
- Backend library: `apps/backend/app/lib/agent-operations-api.js`, `agent-operations-service.js`, new live-turn module, public projector
- DB/migrations: 없음. 기존 mission-thread/session event 저장소를 재사용한다.
- Electron bridge: 기존 credentialed local proxy가 SSE body를 투명하게 전달하는 계약을 재사용하고 회귀 테스트한다.
- React UI: Agent Work API client, SSE parser/hook, composer, live assistant bubble, conversation refresh lifecycle
- Tests: backend route/service, desktop SSE parser/UI, real local gateway Playwright E2E
- Docs: 이 계획과 `docs/DESIGN.md`의 대화 상태 계약(필요한 경우)

## Success Criteria

- [x] 새 Work 생성 또는 메시지 전송은 구성된 Hermes/Codex/local completion으로 연결되는 live-turn 경로를 시작하고, 정적 UI fixture가 아닌 SSE `accepted`/`delta`/`progress`/`done` 이벤트를 renderer에 전달한다. 로컬 E2E는 운영 자격 증명 대신 결정적 completion adapter를 주입했다.
- [x] 사용자는 실행 중인 실제 스트림을 한 개의 타임라인 bubble에서 즉시 보고, 완료 후 새로고침해도 같은 답변을 영속된 checkpoint로 다시 본다.
- [x] 대화 중 `pause`, `cancel`, `revision`, 승인 필요, 지원되지 않는 외부 요청은 기존 안전/영속 계약을 유지하며 허위 스트리밍을 만들지 않는다.
- [x] stream disconnect, runtime failure, duplicate client message ID, 화면 새로고침 실패 시 보내진 사용자 메시지/진행 중이던 상태를 사실대로 복구한다.
- [x] local gateway → Vite renderer → completion adapter → persisted conversation의 실제 HTTP 브라우저 흐름으로 create → live answer → intervention → reload를 검증했다. Electron proxy의 streaming body 보존은 desktop regression test로 함께 검증했다.

## Edge Cases

- 동일 `clientMessageId` 재전송은 새 실행을 시작하지 않고 저장된 결과 또는 replay 사실을 반환한다.
- 새 Work의 initial message는 중복 저장하지 않으면서 첫 live reply를 시작한다.
- 한 Work에서 동시에 두 live completion을 시작하지 않는다. 둘째 요청에는 명시적인 busy/retry 가능한 상태를 준다.
- 종료 전 connection이 끊겨도 이미 저장된 사용자 메시지와 완료 checkpoint를 정합성 있게 읽을 수 있다.
- runtime이 offline/timeout이면 한국어 오류 checkpoint와 재시도 경로를 보이고, 가짜 답변이나 완료를 만들지 않는다.
- SSE payload와 공개 checkpoint는 public projector/redaction을 통과하며 raw tools/secret/private path를 전달하지 않는다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
- [x] live-turn route가 실제 stored user message 뒤 `accepted → delta → done` SSE 순서와 final persisted agent checkpoint를 보장하는 backend test를 추가했다.
- [x] unsupported external message와 duplicate replay가 runtime completion을 호출하지 않는 backend test를 추가했다.
- [x] desktop SSE parser/hook test에서 delta가 live bubble로 보이고 done 뒤 persisted checkpoint로 교체되는지 실패 테스트를 추가했다.
- [x] local gateway browser E2E가 UI fixture route 없이 실제 completion adapter event를 관찰하도록 실패 테스트를 추가했다.
- GREEN:
- [x] single-flight, idempotent, redacted live-turn service와 SSE route를 구현했다.
- [x] renderer streaming client와 live conversation state를 구현하고 composer를 실제 turn API에 연결했다.
- [x] live assistant bubble, interrupt/connection error, durable refresh UI를 구현했다.
- REFACTOR:
- [x] generic chat stream helpers와 Agent Work protocol을 분리하고, production runtime 경로가 legacy mock-only rendering paths에 의존하지 않게 했다.

## Acceptance Gates

- [x] `npm run backend:check`
- [x] focused backend live-turn tests
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test` (107/107)
- [x] focused desktop live conversation test
- [x] `node apps/desktop/tests/playwright-agent-work-gateway-e2e.cjs`
- [x] `npm run build:desktop`
- [x] real local gateway browser capture at 1280px, 768px, 375px, and 640 CSS px effective-width layout (the latter is a 200% layout equivalent, not literal browser zoom)

건너뛴 gate:

- Gate: Railway production deployment and production runtime call
  - Reason: the user has not authorized production changes or use of the production credentials. Local gateway tests will inject a real event-producing completion adapter instead.

- Gate: literal Chrome/Electron browser zoom at 200%
  - Reason: the final visual gate used a 640 CSS px effective-width layout capture. This exercises the same responsive breakpoint pressure, but it is not a claim about the browser's zoom control.

## Implementation Checklist

- [x] Step 1: establish that current Agent Work uses stored JSON plus polling while a runtime completion already emits events that the selected-work renderer never receives.
- [x] Step 2: lock the SSE event schema and idempotency/error behavior with backend RED tests.
- [x] Step 3: add the gateway/service live-turn path, public event projection, persistence, and single-flight control.
- [x] Step 4: add renderer SSE parsing/hook and replace JSON-only composer submission with the live turn lifecycle.
- [x] Step 5: add real gateway browser test and validate responsive UI with actual streamed chunks, not route fixtures.
- [x] Step 6: run acceptance gates, independent visual QA, and document remaining production deployment risk.

## Remaining Risks

- Risk: an offline local runtime cannot produce a live model completion.
  - Mitigation: surface a truthful runtime-unavailable state; never replace it with generated sample chat.
- Risk: a long-running relay profile transports progress by polling relay logs rather than per-token model chunks.
  - Mitigation: preserve every public progress/delta as it arrives and clearly distinguish `응답 중` from final persisted answer; improve adapter granularity separately if the relay exposes richer events.
- Risk: existing deployed Railway gateway does not yet include the new SSE route.
  - Mitigation: validate the source/local gateway end-to-end; do not mask a live deployment mismatch in the desktop client.
