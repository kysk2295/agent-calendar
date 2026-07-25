# Plan: Agent Calendar 과금 안전 재배포

- Date: 2026-07-26
- Owner: Codex
- Work size: Large / Boundary
- Status: In progress

## Goal

과거 Relay 전체 스냅샷 왕복으로 발생한 대용량 네트워크 과금이 재발하지 않도록
백엔드 경계를 고정한다. Railway에는 Agent Calendar API와 기존 Postgres만 다시
실행하고, 별도 Hermes 웹 서비스는 중지 상태로 유지한다.

## Non-Goals

- Agent Calendar 데스크톱 화면이나 기능을 재설계하지 않는다.
- UniPort 또는 personal-memory 서비스를 다시 배포하지 않는다.
- 기존 Postgres 데이터나 볼륨을 삭제·초기화하지 않는다.
- Mac의 Hermes Runtime과 Cloudflare tunnel을 제거하지 않는다.

## Touched Boundaries

- Backend gateway: Relay snapshot 요청 크기 제한과 작은 확인 응답 계약.
- Backend library: 변경 없음.
- DB/migrations: 변경 없음. 기존 289 MB Postgres 볼륨만 재사용한다.
- Electron bridge: 변경 없음.
- React UI: 변경 없음.
- Tests: 과대 snapshot 거부와 응답 크기 회귀 테스트.
- Docs: 이 계획과 검증 결과.
- Railway: canonical Agent Calendar API와 Postgres만 재배포.

## Success Criteria

- [x] 현재 1~2 MiB Relay snapshot은 호환하되 4 MiB를 넘으면 `413`으로 거부된다.
- [x] 허용된 Relay snapshot 업로드 응답에는 snapshot 본문이 포함되지 않는다.
- [x] Relay snapshot에서 DB와 중복되는 태스크·문서 본문은 메모리에 보관하지 않는다.
- [ ] Agent Calendar API와 Postgres만 Railway에서 실행된다.
- [ ] `hermes-os-web`은 배포 중지 상태로 유지된다.
- [ ] 실제 Agent Calendar API health와 데이터 읽기가 정상이다.

## Edge Cases

- `Content-Length`가 한도를 넘으면 본문을 메모리에 쌓지 않고 스트림만 비운다.
- chunked body도 누적 한도를 넘는 즉시 더 이상 메모리에 쌓지 않는다.
- 일반 캘린더 API의 기존 요청 본문 계약은 변경하지 않는다.
- DB 재시작 실패 시 API를 정상으로 오인하지 않고 배포를 중단한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] 현재 크기의 Relay snapshot이 차단되고, 전체 상태가 그대로 보관되는
        회귀 테스트를 먼저 실패시킨다.
- GREEN:
  - [x] 현재 입력을 운영 상태로 축소 저장하고 4 MiB 초과 입력만 `413`으로 반환한다.
- REFACTOR:
  - [x] 기존 작은 확인 응답과 다른 API 본문 처리를 그대로 유지한다.

## Acceptance Gates

- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [ ] `npm test`
- [ ] live `GET /api/gateway-status`
- [ ] authenticated live calendar/task data read
- [ ] Railway service inventory: API + Postgres running, Hermes web stopped

건너뛴 gate:

- Gate:
  - Reason:

## Implementation Checklist

- [x] Relay snapshot 과대 요청 회귀 테스트를 RED로 고정한다.
- [x] snapshot 전용 요청 한도, 운영 상태 축소 저장, 안전한 `413` 응답을 구현한다.
- [ ] 전체 로컬 검증 후 main에 반영한다.
- [ ] Postgres를 먼저 재배포하고 Agent Calendar API를 source에서 재배포한다.
- [ ] 실서비스 health, 데이터 읽기, 서비스 수를 확인한다.

## Rollback

- Code: 이번 단일 커밋을 revert하고 이전 `16d59256801d`를 source redeploy한다.
- API: 실패한 새 deployment는 promote되지 않도록 두고 마지막 정상 deployment를
  재배포한다.
- DB: 기존 volume을 삭제하지 않는다. 재시작 실패 시 추가 변경 없이 중지한다.
- Hermes web: 어떤 단계에서도 재배포하지 않는다.

## Verification Notes

- Command: `node --test apps/backend/tests/relay-snapshot-cost-safety.test.cjs`
  - Result: RED에서 현재 snapshot 호환 실패를 확인했고 구현 후 2/2 통과했다.
- Command: `npm run backend:check && npm run test:backend`
  - Result: syntax check와 backend 286/286 통과.
- Command: `npm run typecheck && npm --workspace apps/desktop run test && npm run build:desktop`
  - Result: typecheck, desktop 141/141, production renderer/Electron build 통과.

## Remaining Risks

- Risk: Hobby 포함량은 보장된 무과금 한도가 아니라 월 $5 사용량 크레딧이다.
  - Mitigation: API 1개와 작은 Postgres 1개만 유지하고 Railway 한도/알림을 유지한다.
