# Plan: Production Runner device neutrality

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified

## Goal

프로덕션 Desktop과 Backend가 특정 사용자의 Mac mini를 제품의 기본 실행 호스트로
가정하지 않도록 한다. 사용자가 직접 붙인 이름은 보존하되, 제품이 만드는 기본 문구,
오류, 상태, 설정 안내는 모두 Workspace에 귀속된 사용자 소유 Runner를 기준으로
표현한다.

## Non-Goals

- Phase 0의 과거 Mac mini 런타임 인벤토리와 기존 Wiki 문서 내용을 삭제하지 않는다.
- 호환성 관찰 기간이 남은 레거시 Relay API를 이번 작업에서 제거하지 않는다.
- macOS, Linux, Windows용 Runner 설치 패키징을 새로 만들지 않는다.
- 사용자가 자기 Runner 이름에 `Mac mini`를 직접 입력한 경우 그 이름을 변경하지 않는다.

## Touched Boundaries

- Backend gateway: `apps/backend/app/railway-gateway-server.js`
- Backend library: 레거시 Relay의 사용자 노출 오류·상태·안내 문구
- DB/migrations: 없음
- Electron bridge: 없음
- React UI: Engine·Connected Automation의 기본 설명과 placeholder
- Tests: 생산 소스의 장비 중립성 계약, 관련 Desktop 표시 계약
- Docs: 이 계획과 검증 기록

## Success Criteria

- [x] 제품이 생성하는 Desktop 기본 문구에 Mac mini가 실행 전제로 나오지 않는다.
- [x] Backend의 상태·오류·채팅·복구 응답이 특정 장비 대신 Workspace Runner를 가리킨다.
- [x] 사용자가 직접 지정한 Runner/자동화 소스 이름은 그대로 표시된다.
- [x] 과거 인벤토리 도구를 제외한 생산 소스에 하드코딩된 Mac mini 제품 가정이 없다.

## Edge Cases

- 사용자 지정 이름: `Mac mini Hermes`도 명시적으로 입력한 이름이면 그대로 보존한다.
- 레거시 Relay 장애: 프로토콜과 오류 코드는 유지하고 사용자 문구만 장비 중립화한다.
- macOS 전용 복구 명령: 실제 `launchctl` 동작은 유지하되 특정 개인 장비로 표현하지 않는다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] 생산 Backend/Desktop/Runner 소스의 하드코딩된 Mac mini 가정을 검출하는 계약 테스트
- GREEN:
  - [x] 동작·코드·저장 의미를 바꾸지 않고 모든 제품 기본 문구를 Runner 중심으로 전환
- REFACTOR:
  - [x] 중복된 사용자 문구만 최소 범위에서 일관되게 정리

## Acceptance Gates

- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`

건너뛴 gate:

- Gate: 없음
  - Reason: 제품 경계를 가로지르는 문구 계약이므로 전체 gate까지 실행한다.

## Implementation Checklist

- [x] Step 1: 장비 중립성 계약을 RED로 고정한다.
- [x] Step 2: Backend 사용자 노출 기본 문구를 Workspace Runner 중심으로 바꾼다.
- [x] Step 3: Desktop Engine·Automation 기본 문구를 Runner 중심으로 바꾼다.
- [x] Step 4: 실제 Desktop 표면에서 기본 문구와 사용자 지정 이름 보존을 확인한다.
- [x] Step 5: 전체 회귀와 정적 잔재 검사를 통과시킨다.

## Verification Notes

- Command: `node --test apps/backend/tests/phase10-runner-device-neutrality.test.cjs`
  - Result: RED에서 59개 하드코딩된 장비 가정을 검출한 뒤 GREEN 1/1.
- Command: `node apps/desktop/tests/playwright-phase7-automation-federation.cjs`
  - Result: PASS. 장비 중립 placeholder, 사용자 지정 이름 보존, 두 Workspace 격리,
    source-owned 자동화와 Calendar occurrence, Desktop/backend 재시작을 실제 Electron에서 확인.
- Command: `npm run backend:check && npm run typecheck`
  - Result: PASS.
- Command: `npm test`
  - Result: PASS — Backend 458, Desktop 260, Runner 29.
- Command: `git diff --check`
  - Result: PASS.

## Remaining Risks

- Risk: 레거시 Relay 자체는 제거되지 않아 내부 식별자와 운영 문서에는 과거 구조가 남는다.
  - Mitigation: 사용자 노출 기본값을 제거하고, Relay 제거는 route lifecycle의 28일
    zero-traffic 관찰 이후 별도 rollback 가능한 변경으로 수행한다.
- Risk: 실제 WorkOS tenant와 공개 배포 환경의 OAuth/domain 설정은 이 로컬 ETE가 증명하지
  않는다.
  - Mitigation: 서명된 Desktop RC와 live AuthKit staging에서 별도 release gate를 통과한다.
