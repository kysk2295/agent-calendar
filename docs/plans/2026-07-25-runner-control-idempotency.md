# Plan: Runner Control Idempotency and client-v1 Contract

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified

## Goal

계정 소유자가 Desktop에서 Runner 등록, 확인, 거절, 연결 테스트, 해제를 수행할 때
네트워크 재전송이나 응답 유실이 같은 동작을 두 번 실행하지 않게 한다. Runner 설정
interface를 `client-v1`에 포함해 Desktop과 향후 지원 클라이언트가 동일한
Workspace-scoped idempotency 계약을 사용하게 한다.

## Non-Goals

- Runner device 서명·fencing protocol을 Workspace HTTP idempotency middleware로
  대체하지 않는다.
- OAuth 로그인·Google authorization start처럼 의도적으로 새 challenge/state를 만드는
  비멱등 interface를 변경하지 않는다.
- 이미 연결된 Runner의 provider credential을 Gateway로 이동하지 않는다.
- Mobile 구현을 시작하지 않는다.
- 실제 외부 Runner 설치·배포를 수행하지 않는다.

## Work Size and Module Design

Runner 설정 route registry, `client-v1` manifest, production dispatch, 실제 PostgreSQL
idempotency persistence, Desktop 계약을 함께 바꾸는 Large / Boundary 작업이다.

기존 `WorkspaceIdempotencyStore`가 깊은 Module이다. 외부 seam은
`client-v1` mutation interface이고, Runner handler마다 replay 코드를 추가하지 않는다.
route registry와 manifest가 idempotency 의미를 선언하고, Gateway composition seam의
하나의 implementation이 모든 supported client retry를 저장·충돌·재생한다.

## Touched Boundaries

- Backend gateway:
  - scoped Runner Control dispatch의 idempotency 적용
- Backend library:
  - production route registry
  - `client-v1` Runner Control family
  - 기존 `WorkspaceIdempotencyStore` 재사용
- DB/migrations:
  - 기존 `idempotency_keys` 사용, migration 없음
- Electron bridge:
  - 변경 없음; 기존 proxy가 request identity를 그대로 전달
- React UI:
  - 변경 없음; 기존 Runner Setup 동작 유지
- Tests:
  - manifest drift/required-key contract
  - 실제 PostgreSQL + HTTP enrollment/test/revoke replay와 A/B isolation
- Docs:
  - 이 계획, 운영 증거, production roadmap

## Success Criteria

- [x] `client-v1`이 Runner 목록, enrollment start/get/confirm/reject, test, revoke interface를
      명시한다.
- [x] 다섯 Runner mutation은 `idempotency-key`를 required로 광고하고 Gateway가 실제로
      동일 key + 동일 payload를 replay한다.
- [x] 동일 key + 다른 payload 또는 다른 Runner target은 409 conflict다.
- [x] Workspace A의 key/response가 Workspace B에 replay되거나 존재를 노출하지 않는다.
- [x] enrollment start 재전송은 enrollment/challenge/code를 하나만 생성한다.
- [x] confirm/reject/test/revoke 재전송은 underlying Runner Control mutation을 한 번만
      실행한다.
- [x] explicit `client-v1` mutation에 key가 없으면 handler 실행 전 400으로 거부한다.
- [x] legacy unversioned request는 compatibility window 동안 기존 동작을 유지한다.
- [x] response/evidence에는 token, credential, device secret, Workspace/User identity가
      나타나지 않는다.

## Edge Cases

- 첫 응답을 클라이언트가 받지 못한 뒤 같은 key로 재시도:
  - 저장된 status/body를 그대로 반환한다.
- 같은 key를 다른 enrollment body나 Runner id에 재사용:
  - `idempotency_key_conflict` 409이며 mutation은 실행하지 않는다.
- 두 Workspace가 같은 key를 사용:
  - 서로 독립적으로 실행되고 response가 교차되지 않는다.
- 두 동시 요청:
  - 하나만 실행하고 다른 요청은 bounded wait 뒤 replay 또는
    `idempotency_in_progress`를 반환한다.
- owner가 아닌 사용자:
  - role check가 먼저 적용되며 idempotency row로 권한 오류를 공유하지 않는다.
- Runner device protocol:
  - device identity/fencing/idempotency 계약을 그대로 유지한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] Runner Control route의 `idempotent`/manifest drift test
  - [x] explicit `client-v1` missing-key 400 test
  - [x] 실제 PostgreSQL enrollment start same-key replay/other-payload conflict test
  - [x] Workspace A/B same-key independent execution test
- GREEN:
  - [x] route registry idempotency meaning을 수정한다.
  - [x] `client-v1` Runner Control family를 추가한다.
  - [x] 기존 Gateway idempotency Module을 Runner user routes에 적용한다.
- REFACTOR:
  - [x] handler별 중복 replay 구현 없이 composition seam 하나로 유지한다.

## Acceptance Gates

- [x] focused Backend contract tests
- [x] real PostgreSQL + loopback HTTP Runner Control tests
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [x] actual Desktop Runner Setup surface regression

## Rollback / Fallback

- route의 `idempotent` 의미와 `client-v1` Runner family를 함께 되돌리면 기존
  non-idempotent Runner Control 동작으로 복귀한다.
- DB schema는 변경하지 않으며 기존 `idempotency_keys` row는 TTL 뒤 만료된다.
- 문제가 발생해도 Runner device protocol과 이미 등록된 Runner identity는 삭제하거나
  재해석하지 않는다.

## Implementation Checklist

- [x] Step 1: Runner Control route/manifest/Desktop request identity를 감사한다.
- [x] Step 2: 실패하는 registry/manifest/HTTP replay/isolation 테스트를 추가한다.
- [x] Step 3: 기존 idempotency seam으로 Runner Control을 연결한다.
- [x] Step 4: 전체 회귀와 실제 Desktop 표면을 관찰한다.
- [x] Step 5: 증거·roadmap을 갱신하고 커밋한다.

## Verification Notes

- Current audit:
  - Desktop proxy는 모든 mutation에 `x-client-request-id`와 `idempotency-key`를 보낸다.
  - Runner enrollment start/confirm/reject/test/revoke route는 `idempotent:false`라
    Gateway가 이 key를 무시한다.
  - `client-v1` manifest에는 Runner Control family가 없어 explicit contract의
    required-key 검증도 적용되지 않는다.
- RED:
  - client-v1 contract 3/5 pass, Runner family와 required-key 2건 fail.
  - Phase 2 focused 0/2 pass, route `idempotent:false`와 missing-key HTTP 200 fail.
- GREEN:
  - client-v1 contract 5/5 pass.
  - Phase 2 focused 2/2, full Phase 2 5/5 pass.
  - route lifecycle 9/9 pass; 167/167 current production routes classified.
  - actual PostgreSQL + HTTP에서 A same-key response exact replay, one challenge row,
    changed payload 409, B same-key independent challenge를 확인했다.
- Actual Electron Runner Setup:
  - 13,760ms, 10 screenshots.
  - login, QR decode, pending fingerprint, confirm, claim, connect/capabilities, test,
    disconnect/reconnect, credential rotation, revoke, Calendar return pass.
- Broad:
  - `npm run backend:check`: pass.
  - `npm test`: pass; Desktop 274/274, Runner 46/46, Backend suite pass.
  - ETE build에서 Desktop typecheck와 production build pass.

Evidence:
`docs/operations/evidence/2026-07-25-runner-control-idempotency.md`.

## Remaining Risks

- 사용자가 버튼을 두 번 눌러 서로 다른 request key를 만든 경우는 transport replay가
  아니라 별도 사용자 명령이다. UI disable/state transition과 Runner Control 자체
  상태 검증이 계속 방어해야 한다.
- 실제 응답 유실을 포함한 WAN fault injection은 staging에서 추가 관찰해야 한다.
