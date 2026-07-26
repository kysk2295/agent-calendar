# Plan: Two-account Runner isolation ETE

- Date: 2026-07-25
- Owner: Codex
- Work size: Large | Boundary
- Status: Verified

## Goal

한 Desktop에서 사용자 A와 사용자 B가 각각 AuthKit으로 로그인하고 자기 Workspace에 자기
Runner를 등록해 작업을 실행했을 때, 상대 사용자의 Runner·Delegated Work·Work
Conversation·Calendar 결과가 실제 제품 화면에 한 번도 나타나지 않음을 증명한다.

## Non-Goals

- 실제 WorkOS tenant credential이나 외부 OAuth 계정을 대신 발급하지 않는다.
- 두 사용자가 하나의 Workspace를 공유하는 협업 모델을 추가하지 않는다.
- Fake Engine ETE를 실제 provider 성공 증거로 사용하지 않는다.
- Mobile 구현을 시작하지 않는다.

## Touched Boundaries

- Backend gateway: 기존 production auth/Workspace/Runner/Durable Execution 경계 검증
- Backend library: 결함 발견 시에만 최소 격리 수정
- DB/migrations: 없음이 기본, 결함 발견 시 계획 갱신
- Electron bridge: logout/login secure-session 전환 검증
- React UI: Account, onboarding, Runner Setup, Agent Work, Calendar 실제 표면
- Tests: 두 계정 clean-account Playwright ETE
- Docs: 다중사용자 격리 운영 증거

## Success Criteria

- [x] 사용자 A/B가 각각 한 번씩 AuthKit 로그인을 완료하고 서로 다른 Workspace를 받는다.
- [x] 각 사용자는 자기 계정으로 발급한 일회용 challenge를 통해 별도 Runner를 등록한다.
- [x] 사용자 B는 로그인 직후 A의 Runner, 작업 제목, 체크포인트, Calendar 결과를 볼 수 없다.
- [x] 사용자 A/B의 Fake Engine 작업은 각각 한 번만 완료되고 자기 Calendar에 한 건만 투영된다.
- [x] 사용자 A로 다시 로그인한 뒤에도 B의 데이터는 보이지 않고 A의 결과만 복원된다.
- [x] DB 소유권 확인은 UI 여정을 보조하며 각 Workspace의 Runner/job/event가 정확히 분리된다.

## Edge Cases

- 로그아웃 뒤 이전 Workspace의 React state나 encrypted snapshot이 잠시 남는 경우
- 사용자 B가 A의 아직 연결된 Runner를 현재 Runner로 오인하는 경우
- Runner A가 Workspace B의 offer를 lease하는 경우
- 같은 날짜의 Calendar hydration이 두 Workspace 결과를 합치는 경우
- 사용자 A 재로그인 시 새 Workspace가 중복 bootstrap되는 경우

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] 기존 single-account ETE harness에 two-account 모드의 격리 assertion을 추가하고
        현재 제품 결함 또는 미지원 harness 지점에서 예상 실패를 확인한다.
- GREEN:
  - [x] AuthKit identity 전환, 두 Runner 등록, 두 작업 실행, logout/login 재복원,
        UI/DB 교차 격리 검증을 통과시킨다.
- REFACTOR:
  - [x] single-account 성공·실패 ETE 계약을 유지하며 사용자별 helper만 최소 추출한다.

## Acceptance Gates

- [x] two-account clean-account ETE
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [x] `git diff --check`

건너뛴 gate:

- Live WorkOS tenant:
  - Reason: 외부 tenant credential이 필요하며 이 ETE는 production auth mode의 injected
    AuthKit adapter와 실제 Electron/Runner/PostgreSQL 경계를 검증한다.

## Implementation Checklist

- [x] Step 1: 기존 로그인·Runner·작업 ETE를 두 identity로 확장한다.
- [x] Step 2: 사용자 B 로그인 직후 A 데이터 부재와 별도 Runner 귀속을 검증한다.
- [x] Step 3: 사용자 B 작업 후 A 재로그인으로 양방향 격리를 검증한다.
- [x] Step 4: 재시작·Runner reconnect·DB ownership 증거와 스크린샷을 남긴다.
- [x] Step 5: 전체 회귀와 운영 증거를 갱신한다.

## Verification Notes

- `AGENT_CALENDAR_E2E_TWO_ACCOUNT=1 node apps/desktop/tests/playwright-phase3-golden-ete.cjs`
  - Result: pass in 30.5s; two login completions, two Workspaces, one Runner/job/Calendar result
    per Workspace, five distinct screenshots, Account A restart without login replay.
- First two-account RED run:
  - Result: completed the product journey and failed only at the new terminal evidence SQL because
    of a missing `w.id as workspace_id` alias. The corrected harness passed without a product
    isolation change.
- `node apps/desktop/tests/playwright-phase3-golden-ete.cjs`
  - Result: existing single-account backend-restart/Desktop-restart journey passed in 27.6s.
- `npm run backend:check`
  - Result: pass.
- `npm test`
  - Result: pass; Desktop 261/261 and Runner 29/29, Backend suite pass.
- `npm --workspace apps/desktop run test`
  - Result: 261/261 after the release workflow began requiring the two-account ETE.
- `git diff --check`
  - Result: pass.

## Remaining Risks

- 실제 WorkOS tenant의 redirect URI/domain 설정은 별도 외부 release gate다.
- 한 Workspace의 다중 멤버십/역할 UI는 현재 one-operator-per-Workspace 릴리스 범위 밖이다.
