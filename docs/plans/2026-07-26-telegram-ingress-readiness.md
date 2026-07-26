# Plan: Telegram ingress readiness

- Date: 2026-07-26
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified
- Parent plan: `docs/plans/2026-07-26-unified-cross-channel-work-conversation.md`

## Goal

마지막 Telegram 수신 확인이 최근인지 Gateway가 판정하고, Desktop이 이 판정과 현재 Runner
연결 상태를 함께 사용해 사용자가 지금 수신 가능한지 정직하게 보여준다.

## Non-Goals

- 기존 Hermes poller를 중지하거나 전용 Bot을 발급하지 않는다.
- 실제 Telegram 메시지 또는 `getUpdates` 요청을 추가로 보내지 않는다.
- `owned`를 영구적인 소유권 보장으로 취급하지 않는다.
- endpoint 등록이나 canonical message delivery 계약을 변경하지 않는다.

## Work Size

Gateway response schema와 Desktop strict parser 계약이 함께 바뀌므로 Boundary 작업이다.

## Touched Boundaries

- Backend gateway:
  - Work Conversation channel response에 제한된 ingress readiness 추가
- Backend library:
  - server 기록 시각 기반 freshness 판정
- DB/migrations:
  - 변경 없음
- Electron bridge:
  - 변경 없음
- React UI:
  - Runner 연결 상태와 ingress readiness를 합친 운영 준비 문구
- Tests:
  - Backend fresh/stale/conflict/unverified projection
  - Desktop strict parser와 사용자 문구
  - mocked Playwright light/dark surface
- Docs:
  - 이 계획과 parent plan verification

## Success Criteria

- [x] 확인 기록이 없는 endpoint는 `unverified`다.
- [x] 150초 안에 확인된 `owned`는 `ready`다.
- [x] 150초 안에 확인된 `conflict`는 `conflict`다.
- [x] 마지막 확인이 150초보다 오래되면 이전 소유권과 무관하게 `stale`다.
- [x] Desktop은 Runner가 disconnected면 `ready`라도 "Runner 연결 필요"로 표시한다.
- [x] UI는 상태 배지, 성공색 테두리, 새 카드 없이 기존 정보 행만 갱신한다.
- [x] API와 화면에 token, chat id, binding handle이 나타나지 않는다.

## Edge Cases

- 서버 시간이 확인 시각보다 이름:
  - 최근 확인으로 간주하되 미래 시각을 API에 새로 생성하지 않는다.
- metadata가 malformed:
  - `unverified`와 null 확인 시각으로 fail closed한다.
- stale conflict:
  - 현재 충돌이라고 단정하지 않고 `stale`로 표시하며 마지막 소유권은 별도 필드에 보존한다.
- fresh owned + Runner offline:
  - Desktop 최종 문구는 "Runner 연결 필요"다.
- fresh conflict + Runner offline:
  - 마지막 관찰된 충돌을 우선해 "수신 주체 전환 필요"로 표시한다.

## Test Plan

- RED:
  - [x] Backend fresh/stale readiness projection이 현재 고정 상태와 달라 실패한다.
  - [x] Desktop parser와 readiness presentation이 새 enum 부재로 실패한다.
- GREEN:
  - [x] 150초 freshness projection을 추가한다.
  - [x] Desktop의 기존 네 칸 정보 행에서 Runner 상태를 운영 준비 문구로 대체한다.
- REFACTOR:
  - [x] readiness variant 분기는 exhaustive presentation 함수 하나에 둔다.

## Acceptance Gates

- [x] focused Backend Telegram channel ETE
- [x] focused Desktop Work Conversation tests
- [x] Orca anti-slop source test
- [x] `npm run backend:check`
- [x] `npm run runner:check`
- [x] `npm run typecheck`
- [x] `npm test`
- [x] `npm run build:desktop`
- [x] mocked Playwright light/dark surface

건너뛴 gate:

- Actual Telegram / production poller cutover:
  - 외부 운영 권한과 전용 Bot 결정이 필요하므로 이번 slice에서 수행하지 않는다.

## Acceptance Gate Conditions

1. `unverified | ready | conflict | stale`가 public enum 밖의 값을 허용하지 않는다.
2. freshness는 Bot이나 Runner가 보낸 시간이 아니라 Gateway가 기록한 확인 시각만 사용한다.
3. stale 상태는 production-ready로 표시되지 않는다.
4. 화면의 등록 상태, 마지막 관찰, 현재 운영 준비 의미가 서로 구분된다.
5. light/dark 모두 같은 평면 위계와 대비를 유지한다.

## Step-by-Step Checklist

- [x] Step 1: Backend/Desktop RED 추가
- [x] Step 2: Gateway freshness projection 구현
- [x] Step 3: Desktop strict parser/presentation/UI 구현
- [x] Step 4: slop review와 수동 QA
- [x] Step 5: 전체 회귀, commit, push

## Rollback / Fallback

- `ingressReadiness` projection과 Desktop 행을 제거하면 기존 ownership/checkedAt 표시로 돌아간다.
- DB와 Runner 상태 보고 형식은 변경하지 않으므로 rollback 시 데이터 변환이 필요 없다.
- 알 수 없는 readiness payload는 Desktop parser에서 fail closed한다.

## Verification Notes

- focused Backend Telegram ETE:
  - fresh owned/conflict, ten-minute stale, malformed timestamp fail-closed, future timestamp
    clock-skew 처리가 통과했다.
- focused Desktop:
  - readiness 문구, Runner 연결 상태, endpoint offline/revoked, impossible enum tuple
    fail-closed가 통과했다.
- full local regression:
  - Backend 515/515, Desktop 294/294, Runner 60/60.
- static/build:
  - `npm run backend:check`, `npm run runner:check`, `npm run typecheck`,
    `npm run build:desktop`가 통과했다.
- mocked Playwright:
  - light/dark 모두 conflict 상태와 네 칸 정보 행을 렌더링했다.
  - 패널은 `border-radius: 0`, `box-shadow: none`이며 성공색 테두리나 새 배지가 없다.
  - evidence:
    - `apps/desktop/test-results/telegram-ingress-readiness/conflict-light.png`
    - `apps/desktop/test-results/telegram-ingress-readiness/conflict-dark.png`

## Remaining Risks

- freshness는 최근 polling 성공을 뜻하며 Telegram이 장래에도 독점 수신을 보장한다는 의미가 아니다.
- 실제 production ingress gate는 기존 poller 중지 후 단독 수신과 rollback 관찰이 필요하다.
