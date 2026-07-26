# Plan: Telegram ingress ownership visibility

- Date: 2026-07-26
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified
- Parent plan: `docs/plans/2026-07-26-unified-cross-channel-work-conversation.md`

## Goal

Runner가 Telegram `getUpdates`를 실제로 수행한 결과를 Workspace 경계 안에서 Gateway에
보고하고, 사용자가 Work Conversation에서 수신 가능 또는 다른 poller와의 충돌 상태를
명확히 확인할 수 있게 한다.

`active` endpoint는 계속 "Runner에 등록됨"만 의미한다. Telegram 수신 소유권은 별도
상태로 유지하며 Bot token, chat id, binding handle은 API나 화면에 노출하지 않는다.

## Non-Goals

- 기존 Hermes poller를 자동으로 중지하거나 live Telegram 수신 주체를 전환하지 않는다.
- Bot token 또는 chat id를 Gateway에 업로드하지 않는다.
- Telegram webhook 방식으로 전환하지 않는다.
- endpoint 등록, canonical message, delivery cursor의 기존 의미를 바꾸지 않는다.
- Telegram에 실제 테스트 메시지를 보내지 않는다.

## Work Size

Runner, Gateway route/service, PostgreSQL projection, Desktop parser/UI의 네 경계를 통과하는
계약 변경이므로 Large / Boundary로 분류한다.

## Touched Boundaries

- Backend gateway:
  - Runner device용 Telegram ingress 상태 보고 route
- Backend library:
  - same-Workspace/same-Runner endpoint 검증과 제한된 상태 저장
  - Work Conversation의 credential-free 상태 projection
- DB/migrations:
  - 새 migration 없음
  - 기존 `work_conversation_channel_endpoints.public_metadata`에 제한된 상태만 저장
- Electron bridge:
  - 변경 없음
- React UI:
  - Telegram 수신 상태 문구와 최근 확인 시각
- Runner:
  - `getUpdates` 성공 및 409 충돌을 endpoint 상태로 보고
- Tests:
  - Runner credential redaction 및 상태 전환
  - Backend hostile Workspace/Runner 접근 차단 및 public projection
  - Desktop strict parser와 Orca식 중립 상태 표시
- Docs:
  - 이 계획과 parent plan 체크리스트

## Success Criteria

- [x] 새 Telegram endpoint는 수신 확인 전 `unverified`로 보인다.
- [x] Runner가 `getUpdates`에 성공하면 `owned`와 확인 시각을 보고한다.
- [x] Telegram 409가 발생하면 Runner가 `conflict`를 보고한 뒤 기존 명시적 오류를 유지한다.
- [x] 다른 Runner 또는 다른 Workspace는 endpoint 상태를 변경할 수 없다.
- [x] public API에는 `unverified | owned | conflict`와 확인 시각만 나오며 credential-shaped
      값, binding handle, chat id는 나오지 않는다.
- [x] Desktop은 등록 상태와 수신 상태를 혼동하지 않고 각각 표시한다.
- [x] `owned`는 "수신 확인됨", `conflict`는 "다른 수신 주체와 충돌", 미확인은
      "수신 소유권 미확인"으로 표시한다.
- [x] UI는 성공색 테두리, 상태 카드 추가, 장식 점 없이 기존 얇은 중립 구분선 위계를 유지한다.

## Edge Cases

- 최초 offset 초기화에서 409:
  - endpoint가 이미 bind된 뒤 `conflict`를 보고하고 `TELEGRAM_INGRESS_CONFLICT`를 다시 던진다.
- 정상 수신 후 다른 poller가 시작됨:
  - 다음 409에서 `owned`를 `conflict`로 덮어쓴다.
- 충돌 후 poller가 제거됨:
  - 다음 성공 시 `conflict`를 `owned`로 되돌린다.
- Runner가 offline:
  - 마지막 ingress 관찰은 보존하되 Desktop의 별도 Runner 상태가 연결 확인 필요로 보인다.
- 상태 보고 자체가 실패:
  - 원래 Telegram 오류를 credential-free 형태로 유지하고 로그에 token/chat id를 포함하지 않는다.
- hostile endpoint id:
  - same-Workspace/same-Runner 조회 실패를 404로 반환한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] Runner 성공 경로가 `owned`, 409 경로가 `conflict`를 보고하며 token/chat id를 보내지 않는다.
  - [x] Backend status route가 allowed enum만 저장하고 foreign Runner/Workspace를 404로 거부한다.
  - [x] Work Conversation projection이 제한된 상태와 ISO 확인 시각만 반환한다.
  - [x] Desktop parser와 화면이 세 상태를 엄격하게 구분한다.
- GREEN:
  - [x] 최소 status route/service와 Runner report 호출을 구현한다.
  - [x] 기존 Work Conversation projection과 텍스트 행만 확장한다.
- REFACTOR:
  - [x] 중복 상태 문구를 작은 presentation 함수로만 정리한다.

## Acceptance Gates

- [x] focused Runner Telegram tests
- [x] focused Backend durable execution/channel tests
- [x] focused Desktop Work Conversation tests
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run runner:check`
- [x] `npm run test:runner`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] mocked Playwright Work Conversation status states
- [x] `npm test`

건너뛴 gate:

- Actual Telegram message:
  - 기존 Hermes poller의 live 수신 소유권을 침범하지 않기 위해 보내지 않는다.
- Production cutover:
  - poller 중지 또는 전용 Bot 선택은 외부 운영 권한이 필요한 별도 gate다.

## Acceptance Gate Conditions

1. `unverified`, `owned`, `conflict` 세 상태가 Runner부터 Desktop까지 같은 의미로 왕복한다.
2. 409 상태에서도 canonical conversation과 outbound cursor는 변경되지 않는다.
3. endpoint 및 Runner의 Workspace 소유권 검사가 모든 상태 쓰기 전에 수행된다.
4. API, 로그, 테스트 evidence에 Bot token, chat id, binding handle이 포함되지 않는다.
5. Work Conversation 화면에서 등록 상태와 Telegram 수신 상태를 한눈에 구분한다.

## Step-by-Step Checklist

- [x] Step 1: Runner/Backend/Desktop 실패 테스트 추가
- [x] Step 2: Backend status route와 제한된 metadata 저장
- [x] Step 3: Runner success/conflict 상태 보고
- [x] Step 4: public projection과 Desktop strict parser 확장
- [x] Step 5: Orca식 중립 문구 표시와 mocked Playwright 수동 QA
- [x] Step 6: 전체 회귀, commit, push

## Rollback / Fallback

- 새 status route 호출을 Runner에서 제거하면 endpoint는 기존처럼 `unverified`로 투영된다.
- `public_metadata`가 없거나 잘못된 기존 row는 projection에서 `unverified`로 fail closed한다.
- UI는 알 수 없는 상태를 parse error로 거부하고 기존 데이터는 `unverified`로 호환된다.
- live poller cutover 없이도 기존 Desktop 및 Telegram delivery 기능은 유지된다.

## Verification Notes

- RED:
  - Runner 2건, Backend route/projection 2건, Desktop parser/presentation 1건이
    구현 전 각각 기대한 계약 부재로 실패했다.
- Focused GREEN:
  - Runner Telegram 4/4;
  - Backend Telegram route/hostile endpoint ETE 2/2;
  - Desktop Work Conversation와 Orca surface 31/31.
- Full regression:
  - Backend 515/515;
  - Desktop 293/293;
  - Runner 60/60;
  - Backend/Runner syntax, Desktop typecheck, Desktop production build, `git diff --check` passed.
- Manual surface QA:
  - mocked Telegram 409으로 밝은/어두운 Work Conversation을 렌더링했다;
  - 등록 상태와 충돌 상태가 분리되고 credential 문자열은 없으며 기존 평면 UI를 유지했다;
  - `apps/desktop/test-results/telegram-ingress-ownership/conflict-light.png`;
  - `apps/desktop/test-results/telegram-ingress-ownership/conflict-dark.png`.

## Remaining Risks

- 기존 Hermes poller가 같은 Bot을 계속 소유하면 실제 상태는 `conflict`가 정상이다.
  안전한 수신 주체 전환 전에는 production ingress ready로 간주하지 않는다.
- 상태는 마지막 관찰값이다. Runner 연결 상태와 확인 시각을 함께 표시해 오래된 `owned`를
  현재 연결 보장처럼 오해하지 않게 한다.
