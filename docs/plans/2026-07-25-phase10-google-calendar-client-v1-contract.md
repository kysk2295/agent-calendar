# Plan: Phase 10 Google Calendar OAuth client-v1 contract closure

- Date: 2026-07-25
- Owner: Codex
- Work size: Boundary
- Status: Verified

## Goal

Google Calendar 연결을 수행하는 Electron main-process 요청도 동결된 `client-v1`
계약을 사용한다. OAuth 시작·완료와 첫 동기화가 계약 협상 및 재시도 식별자 규칙을
지켜 Desktop과 향후 Mobile이 같은 명시적 API 경계에 의존하게 한다.

## Non-Goals

- Google Cloud 운영 OAuth credential을 생성하거나 배포하지 않는다.
- Google Calendar OAuth callback 또는 token vault의 서버 동작을 재설계하지 않는다.
- Mobile 제품 코드를 시작하지 않는다.

## Touched Boundaries

- Backend gateway: 없음
- Backend library: `apps/backend/app/lib/client-v1-contract.js`
- DB/migrations: 없음
- Electron bridge: `apps/desktop/electron/calendarOAuth.ts`
- React UI: 없음
- Tests: Backend client-v1 contract, Desktop Google Calendar OAuth
- Docs: 이 계획과 단계별 검증 증거

## Success Criteria

- [x] Google OAuth 시작·완료 route가 `client-v1` manifest에 동결된다.
- [x] Electron Google Calendar 요청이 `client-v1` media type/header를 항상 전송한다.
- [x] OAuth callback과 첫 sync는 `x-client-request-id`와 동일한
      `idempotency-key`를 전송하며, 비멱등 authorize에는 idempotency key를 붙이지 않는다.
- [x] credential, OAuth code/state, Workspace 식별자가 계약 manifest나 공개 결과에
      추가되지 않는다.

## Edge Cases

- authorize는 서버 계약상 비멱등이므로 요청 추적 ID만 보내고 재시도 키는 보내지 않는다.
- callback state가 불일치하면 어떤 네트워크 요청이나 식별자도 만들지 않는다.
- 첫 sync가 실패해도 연결된 source 결과와 정직한 sync 실패 상태를 반환한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] Backend manifest가 Google authorize/callback을 포함해야 한다.
  - [x] Desktop OAuth의 실제 4개 요청이 계약·요청·멱등성 header 정책을 따라야 한다.
- GREEN:
  - [x] 기존 공유 Electron 계약 helper를 사용해 최소 header 연결만 구현한다.
- REFACTOR:
  - [x] OAuth 흐름·오류 문구·public source shape는 그대로 유지한다.

## Acceptance Gates

- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`

건너뛴 gate:

- Gate: live Google OAuth
  - Reason: 운영 Google Cloud OAuth credential과 callback 설정은 외부 prerequisite다.

## Implementation Checklist

- [x] Step 1: 누락된 계약과 Electron header 정책을 실패 테스트로 고정한다.
- [x] Step 2: manifest와 main-process OAuth client를 최소 수정한다.
- [x] Step 3: 실제 HTTP harness로 계약 협상 및 idempotency validation 통과를 관찰한다.
- [x] Step 4: 전체 회귀와 문서 갱신 후 커밋한다.

## Verification Notes

- Focused Backend + Desktop:
  - Result: 9/9 passed.
- `npm run backend:check`, `npm run typecheck`, `npm run build:desktop`:
  - Result: passed. Vite의 기존 large-chunk warning만 남았다.
- `npm test`:
  - Result: Backend 502/502, Desktop 274/274, Runner 41/41 passed.
- Real local HTTP socket:
  - Result: authorize/callback/sync/list 네 요청의 contract/request/idempotency header 정책과
    public connected-source 결과를 관찰했다. Evidence:
    `docs/operations/evidence/2026-07-25-phase10-google-calendar-client-v1-contract.md`.

## Remaining Risks

- Risk: live Google OAuth provider 동작은 credential이 없으면 검증할 수 없다.
  - Mitigation: local real HTTP Gateway에서 계약 validation을 검증하고, live 연결은
    외부 credential이 준비된 staging release gate로 유지한다.
