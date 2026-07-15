# Plan: Incremental Agent Work streaming and live state

- Date: 2026-07-15
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified

## Goal

Hermes와 로컬 LLM으로 실행하는 작업 대화가 실제 생성 중인 텍스트를 여러 delta로 점진적으로 표시한다. 첫 유효 답변이 저장되면 위임 작업은 더 이상 `draft`로 남지 않고, 같은 작업 대화에서 후속 지시와 상태 제어를 계속할 수 있다.

## Non-Goals

- 모든 Hermes profile의 답변 품질을 이번 변경에서 개별 튜닝하지 않는다.
- Business Consultant의 stopped 설정을 임의로 켜지 않는다.
- 계획·승인·작업 정보 패널의 전면 재설계는 이번 변경에 포함하지 않는다.
- 외부 전송·게시·구매·삭제 기능을 추가하지 않는다.

## Touched Boundaries

- Backend gateway: `apps/backend/app/railway-gateway-server.js`
- Backend library: `apps/backend/app/lib/relay-chat-completion.js`, `apps/backend/app/lib/agent-work-live-turn.js`
- DB/migrations: 없음. 기존 mission/session/event 저장 의미를 재사용한다.
- Electron bridge: 기존 credentialed SSE proxy를 회귀 검증한다.
- React UI: `apps/desktop/src/features/agent-operations/**`의 live text와 mission status 표시
- Remote runtime: `/Users/goyunseo/.hermes/os-runtime/scripts/hermes-railway-relay-bridge.js`
- Remote Hermes Agent: `/Users/goyunseo/.hermes/hermes-agent/cli.py`, `hermes_cli/_parser.py`, `hermes_cli/main.py`
- Tests: backend relay/live-turn, desktop SSE parser/Playwright, remote bridge tests
- Docs: 이 계획과 운영 검증 증거

## Success Criteria

- [x] Hermes `profile.chat`가 완료 직전 한 번의 전체 답변이 아니라 순서가 보존된 둘 이상의 non-empty delta를 보낼 수 있다.
- [x] 로컬 LLM `chat.completions`가 받은 provider stream chunk를 Railway delta로 즉시 전달하고 완료 payload와 중복시키지 않는다.
- [x] 작업 대화 renderer의 partial answer가 delta마다 증가하고, final checkpoint 저장 후 live bubble이 제거된다.
- [x] 최초 실제 agent answer가 저장되면 mission status가 `draft`에서 `active`로 전환되고 reload 뒤에도 유지된다.
- [x] Hermes와 로컬 LLM 각각 실제 configured desktop origin에서 nonce 답변, progressive frames, follow-up, persistence, reload를 통과한다.
- [x] 중지·오류·빈 응답 경로는 mission을 `active`로 올리지 않으며 terminal event를 보장한다.

## Edge Cases

- provider가 한 chunk만 반환하면 답변은 저장하되 token streaming 합격 증거로 세지 않는다.
- delta 합계와 complete text가 같을 때 final text를 중복 append하지 않는다.
- stream 중 오류가 발생하면 partial answer와 오류를 구분하고 mission status를 거짓으로 활성화하지 않는다.
- 같은 `clientMessageId` 재시도는 저장된 답변을 재생하고 runtime을 다시 호출하지 않는다.
- remote child process timeout은 Railway job을 `error`와 `complete ok:false`로 닫고 prompt/경로를 노출하지 않는다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] live-turn 성공 뒤 mission이 `draft`인 결함을 backend test로 재현한다.
  - [x] bridge가 full stdout 하나만 delta로 보내는 결함을 remote bridge test로 재현한다.
  - [x] configured-runtime Playwright가 둘 이상의 증가하는 answer frame을 요구해 현재 운영에서 실패함을 확인한다.
- GREEN:
  - [x] final agent message 저장과 mission `active` 전환을 같은 성공 경로에 적용한다.
  - [x] Hermes/local LLM child/provider stdout stream을 chunk callback으로 Railway event에 전달한다.
  - [x] gateway와 renderer가 순서대로 받은 delta를 중복 없이 누적한다.
- REFACTOR:
  - [x] engine별 streaming adapter의 공통 terminal/error 계약만 최소 정리한다.

## Acceptance Gates

- [x] focused backend RED/GREEN tests
- [x] remote bridge focused/full tests and `node --check`
- [x] `npm run backend:check`
- [ ] `npm run test:backend` (172 pass, 0 fail, 1 cancelled: 기존 `agent-operations.test.cjs` pending Promise)
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] Hermes configured-runtime Playwright
- [x] local LLM configured-runtime Playwright
- [x] `git diff --check`

건너뛴 gate:

- Gate: `npm test`
  - Reason: 실행 시 backend aggregate의 기존 pending-promise 종료 문제를 먼저 재평가하고, 재현되면 focused backend와 독립 desktop suite 결과를 분리 기록한다.

## Implementation Checklist

- [x] Step 1: 현재 relay/remote bridge delta 계약과 mission 상태 전환 지점을 테스트로 고정한다.
- [x] Step 2: 성공한 live reply가 mission을 `active`로 전환하도록 최소 구현한다.
- [x] Step 3: remote Hermes와 local LLM bridge를 incremental event producer로 수정한다.
- [x] Step 4: gateway/desktop의 delta 누적과 상태 표시를 회귀 검증한다.
- [x] Step 5: Railway 배포 후 두 엔진의 실제 desktop E2E와 reload를 검증한다.

## Verification Notes

- Baseline Hermes actual first answer: 약 23.7초, final answer 중심의 8 live DOM frames.
- Baseline local LLM actual first answer: 약 19.0초, work `mission-work-57508b2c4e437ce548827a82`; persisted engine `local_llm`, mission status remained `draft`.
- Remote Hermes Agent focused tests: 25 passed; os-runtime full tests: 18 passed; bridge syntax passed.
- Remote Hermes actual: default profile 17 delta(14 non-empty), first delta 12.587초, complete 13.324초, delta 합계와 complete text 일치. bridge module actual은 16 delta, first delta 14.483초, complete 17.184초.
- Remote service: `com.yunseo.hermes-railway-relay`, PID `82617`; `bridgeOnline=true`, `pendingJobs=0`, `activeJobs=0`.
- Railway deployment: `f726c2a8-1a15-4660-8810-6a0d57015280` SUCCESS.
- Hermes desktop actual: work `mission-work-5f43746f8a9425c00c046544`, first visible delta 20.458초, 21 progressive answer frames, persisted status `active`, follow-up/reload/mobile/bottom console passed.
- Local LLM desktop actual: work `mission-work-e8c415010ba77feb368aff0e`, first visible delta 14.188초, 30 progressive answer frames, persisted status `active`, follow-up/reload passed.
- Work Conversation에서 relay transport progress와 `[redacted-command]` 카드가 저장되지 않는 것을 실제 Hermes E2E와 focused backend 5/5로 확인했다.
- Desktop suite 112/112, desktop build, backend syntax, typecheck passed.
- Backend aggregate는 90초 제한에서 172 pass, 0 fail, 1 cancelled였다. 취소 원인은 기존 `tests/agent-operations.test.cjs`의 `Promise resolution is still pending`이다.

## Remaining Risks

- Risk: Railway/provider buffering이 첫 byte를 늦출 수 있다.
  - Current evidence: provider/bridge first delta는 약 12.6~14.5초, desktop first visible delta는 약 14.2~20.5초로 기능은 동작하지만 목표 체감 지연 3~5초보다 느리다.
  - Mitigation: 다음 성능 작업에서 bridge enqueue, provider first byte, Railway delivery, DOM render 구간을 별도 계측한다.
