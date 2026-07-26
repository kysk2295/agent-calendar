# Plan: Closed client-v1 Desktop Surface

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified

## Goal

Desktop이 `client-v1`을 선언한 모든 제품 요청을 manifest에 포함하고, manifest 밖의
Workspace 제품 route는 explicit `client-v1` 요청으로 사용할 수 없게 한다. Desktop,
향후 Mobile, Gateway가 하나의 실제 지원 interface를 공유하게 하고 숨은 Desktop-only
제품 계약을 제거한다.

## Non-Goals

- Mobile UI나 Mobile 앱 구현을 시작하지 않는다.
- public health/status, operations, provider webhook, Runner device protocol을 Workspace
  product manifest에 억지로 포함하지 않는다.
- compatibility/removal-candidate route를 트래픽 증거 없이 삭제하지 않는다.
- 기존 unversioned client compatibility window를 즉시 종료하지 않는다.
- response payload 전체를 새 schema로 재작성하지 않는다.

## Work Size and Module Design

Backend route registry, Desktop inventory, `client-v1` manifest/negotiation, route lifecycle,
Desktop 실제 표면이 함께 바뀌는 Large / Boundary 작업이다.

`client-v1-contract.js`가 깊은 Module이다. Interface는 immutable manifest,
registry/consumer 역방향 drift assertion, request validation 세 가지로 유지한다.
Gateway composition seam이 explicit contract의 유일한 enforcement 지점이다.
Desktop과 향후 Mobile은 같은 HTTP Adapter를 사용하고 handler별 contract 분기를
추가하지 않는다.

## Touched Boundaries

- Backend gateway:
  - explicit client-v1 unlisted product route rejection
- Backend library:
  - `client-v1` manifest
  - Desktop route inventory
  - route lifecycle classification
- DB/migrations:
  - 없음
- Electron bridge:
  - 변경 없음; 기존 proxy contract header 전달 유지
- React UI:
  - 변경 없음; 실제 사용 route가 manifest와 일치하는지 검증
- Tests:
  - manifest reverse coverage/drift
  - missing idempotency key
  - unlisted product route fail-closed
  - Desktop source inventory
  - 실제 HTTP/Electron regression
- Docs:
  - 이 계획, 증거, roadmap, client-v1 기존 증거

## Success Criteria

- [x] Desktop이 사용하는 모든 scoped/auth product route가 `client-v1` manifest에 있다.
- [x] Agent create/update/archive/restore, provider catalog import, provider session
      list/import/update route가 Desktop inventory와 manifest에 모두 있다.
- [x] manifest assertion이 manifest→registry뿐 아니라 Desktop inventory→manifest drift도
      실패시킨다.
- [x] explicit `client-v1`이 manifest 밖 scoped/auth product route를 요청하면 handler
      실행 전 406 `client_route_not_in_contract`다.
- [x] manifest에 포함된 모든 idempotent mutation은 key가 없으면 400이다.
- [x] ordinary unversioned 요청은 compatibility window 동안 기존 동작을 유지한다.
- [x] route lifecycle에 manifest 밖 `stable-desktop` scoped product route가 0개다.
- [x] public infra, Runner device, provider webhook은 기존 독립 protocol을 유지한다.
- [x] manifest/evidence에 Workspace, user, credential, token, request payload가 없다.

## Edge Cases

- 새 Desktop method가 inventory에만 추가됨:
  - client-v1 reverse drift gate가 실패한다.
- 새 manifest operation이 registry와 다름:
  - 기존 forward drift gate가 실패한다.
- explicit client-v1이 등록됐지만 미동결된 scoped product route를 호출:
  - 406이며 인증 이후 제품 handler는 실행하지 않는다.
- public `GET /api/gateway-status`가 contract header를 사용:
  - public infra negotiation은 허용하되 product operation으로 광고하지 않는다.
- unversioned legacy client:
  - 등록된 route의 기존 auth/handler 동작을 유지한다.
- SSE:
  - manifest에 포함된 stream만 content type을 보존한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] Desktop inventory route 39개가 manifest에 없음을 실패로 고정한다.
  - [x] Agent provider management route가 Desktop inventory에 없음을 실패로 고정한다.
  - [x] Settings/Agent catalog mutation의 missing-key가 현재 통과하는 HTTP test를 추가한다.
  - [x] manifest 밖 scoped product route의 explicit client-v1 요청이 현재 통과하는 test를
        추가한다.
- GREEN:
  - [x] 기존 family에 supported Desktop operations를 추가한다.
  - [x] Agent Control과 Workspace Core family를 추가한다.
  - [x] reverse drift assertion과 unlisted product rejection을 구현한다.
- REFACTOR:
  - [x] contract enforcement를 Gateway composition seam 하나에 유지한다.

## Acceptance Gates

- [x] focused client-v1/route lifecycle tests
- [x] Desktop inventory/source contract tests
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [x] actual Electron production-surface regression

## Rollback / Fallback

- 신규 manifest operations, reverse drift assertion, unlisted product rejection을 함께
  되돌리면 이전 additive manifest 동작으로 복귀한다.
- DB와 persisted data 의미는 변경하지 않는다.
- 문제가 발생해도 unversioned compatibility request는 유지되며 Desktop contract
  header를 제거하는 fallback은 사용하지 않는다.

## Implementation Checklist

- [x] Step 1: Desktop inventory, manifest, lifecycle의 양방향 차이를 감사한다.
- [x] Step 2: inventory/reverse-drift/request-validation RED를 추가한다.
- [x] Step 3: closed manifest와 Gateway enforcement를 구현한다.
- [x] Step 4: focused/full regression과 Electron 표면을 관찰한다.
- [x] Step 5: 증거·roadmap을 갱신하고 커밋한다.

## Verification Notes

- Current audit:
  - RED baseline: manifest 65 operations / 8 families, Desktop inventory 70 routes,
    manifest 밖 Desktop route 39개.
  - GREEN: manifest 112 operations / 10 families, Desktop inventory 80 routes.
  - `stable-desktop` scoped/auth product route: 0.
  - focused client-v1/lifecycle: 15/15.
  - full regression: Backend 506, Desktop 274, Runner 46.
  - actual Electron + real Codex Runner: 101,338ms, provider catalog/session import,
    same-session follow-up, tool checkpoint, artifact, Gateway/Desktop restart restore 통과.
  - Electron identity는 injected AuthKit이므로 production release evidence는 아니다.
  - Evidence:
    `docs/operations/evidence/2026-07-25-client-v1-closed-desktop-surface.md`.

## Remaining Risks

- Desktop inventory는 정적 contract이므로 renderer method 추가 시 source-level drift
  test도 함께 유지해야 한다.
- payload field-level breaking change는 이 route-level interface만으로 검출되지 않는다.
- compatibility route 삭제는 여전히 production traffic과 rollback observation이 필요하다.
- production WorkOS와 서로 분리된 두 provider home의 two-account ETE는 이 계약
  closure와 별개의 Agent 기능 release gate로 계속 열려 있다.
