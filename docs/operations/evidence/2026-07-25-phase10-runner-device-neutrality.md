# Phase 10 Runner device-neutrality evidence

- Date: 2026-07-25
- Result: Pass
- Scope: production Backend, Desktop, Electron, and Runner source copy

## Observable result

Agent Calendar가 만드는 기본 문구는 특정 사용자의 Mac mini를 실행 전제로 삼지 않는다.
Desktop의 Connected Automation 연결 화면은 `예: 내 Hermes Runner`를 안내하고,
Backend의 오류·상태·복구 응답은 해당 사용자의 `Workspace Runner` 또는 `Runner host`를
가리킨다.

사용자가 Runner/자동화 소스 이름으로 `Mac mini Hermes`를 직접 입력한 경우에는 그
사용자 지정 이름을 그대로 보존한다. 장비 중립성은 제품의 기본 가정에 적용되며 사용자
소유 장비의 실제 이름을 변경하지 않는다.

## Contract evidence

`apps/backend/tests/phase10-runner-device-neutrality.test.cjs`는 다음 생산 소스를 재귀적으로
검사한다.

- `apps/backend/app/lib/**`
- `apps/backend/app/railway-gateway-server.js`
- `apps/desktop/src/**`
- `apps/desktop/electron/**`
- `apps/runner/src/**`

과거 단일 사용자 배포를 진단하기 위한
`apps/backend/app/lib/macmini-runtime-inventory.js`만 명시적으로 제외한다. 이 도구는
제품 사용자 문구나 현재 Runner 실행 경로가 아니다.

- RED: 59개 하드코딩된 `Mac mini`/`맥미니`/`맥 미니` 제품 가정 검출
- GREEN: 0개

## Real surface evidence

`node apps/desktop/tests/playwright-phase7-automation-federation.cjs`:

- production-mode Electron + AuthKit adapter + ephemeral PostgreSQL
- Account A의 Runner와 Account B의 Runner/Workspace 격리
- 연결 전 source name placeholder `예: 내 Hermes Runner`
- 연결 전 화면의 하드코딩된 `Mac mini` 문구 0개
- 사용자 지정 source name `Mac mini Hermes` 보존
- Connected Automation create/update/pause/resume/run
- source-owned occurrence가 Unified Calendar에 정확히 한 번 표시
- Backend와 Desktop 재시작 후 source, automation, receipt, occurrence 보존

화면:

- `apps/desktop/test-results/phase7-automation-federation/00-runner-neutral-setup.png`
- `apps/desktop/test-results/phase7-automation-federation/01-source-connected.png`

자동 증거:

- `docs/operations/evidence/2026-07-25-phase7-automation-federation.json`

## Verification

- `npm run backend:check`: Pass
- `npm run typecheck`: Pass
- Desktop production build inside the Phase 7 ETE: Pass
- `npm test`: Pass
  - Backend: 458/458
  - Desktop: 260/260
  - Runner: 29/29
- `git diff --check`: Pass

One full-suite run encountered a transient pre-existing Phase 6 PostgreSQL fixture miss; the same
Phase 6 test passed 3/3 in isolation, and the subsequent unchanged full suite passed all 747 tests.
No Phase 6 product input was changed by this slice.

## Release boundary

This proves device-neutral product behavior and two-Workspace local ETE behavior. It does not prove
the external WorkOS tenant redirect/domain configuration, signed/notarized Desktop distribution, or
public signup availability; those remain live release gates.
