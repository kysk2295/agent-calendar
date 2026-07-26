# Plan: Orca-inspired product surfaces anti-slop redesign

- Date: 2026-07-25
- Owner: Codex
- Work size: Large
- Status: Complete

## Goal

Agent Calendar의 Desktop 제품 화면 전체를 Orca처럼 조용하고 조밀한 작업 도구로
정리한다. Unified Calendar를 중심에 둔 기존 정보 구조와 동작은 유지하면서 로그인,
시작 가이드, Agent Work Control Space, 자동화, 설정에서 AI식 장식과 카드 남용을
제거한다.

## Non-Goals

- Backend, Workspace 격리, Runner, Calendar AI 또는 자동화 API 계약을 바꾸지 않는다.
- Orca의 로고, 브랜드 문구, 터미널 중심 정보 구조를 복제하지 않는다.
- Landing page나 Mobile UI를 이번 단계에서 구현하지 않는다.
- 실제 데이터나 상태를 숨겨 화면을 단순해 보이게 만들지 않는다.

## Work Size

Large. 공통 Desktop shell에 더해 로그인, 온보딩, 설정, Agent Work, Knowledge와
Automation의 React/CSS 표면 및 실제 Electron QA가 함께 변경된다.

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge: 진행 중인 release safety 변경의 회귀 검증만 수행
- React UI: `apps/desktop/src/App.tsx`, feature components
- Styling: 전역 tokens와 feature CSS
- Tests: 구조 계약, 실제 Electron 라이트/다크 시각 QA
- Docs: 이 계획, `docs/DESIGN.md`, 검증 증거

## Design Read

- Mode: 기존 IA와 브랜드 자산을 보존하는 Desktop product redesign
- Audience: 일정과 에이전트 작업을 동시에 감독하는 일반 사용자
- Reference: Orca Desktop의 neutral tool chrome, compact sidebar, inline status,
  full-height settings, restrained onboarding
- Dials:
  - Design variance: 4
  - Motion intensity: 2
  - Visual density: 7

## Reference Audit

Orca 공식 제품 화면과 공개 소스에서 다음을 채택한다.

- light `#ffffff`, sidebar `#f5f5f5`, dark `#0a0a0a/#171717` 중심의 중성 팔레트
- 12-13px 본문, 11px 보조 정보, 28-32px control 중심의 작업 도구 밀도
- 그림자 대신 1px border와 한 단계의 surface 차이로 만드는 계층
- unread/attention을 큰 badge 대신 글자 굵기와 인라인 상태로 표시
- settings와 onboarding을 별도 작업 표면으로 취급
- 빈 상태는 한 문장과 한 행동만 제공

Agent Calendar에서 유지한다.

- Unified Calendar가 첫 화면인 정보 구조
- terracotta accent는 primary action과 현재 날짜에만 제한
- 기존 화면 이름, 내비게이션 순서, `data-testid`, keyboard 동작
- light/dark theme와 시스템 접근성 설정

제거하거나 축소한다.

- beige/cream page wash와 brown dark theme
- splash orbit, gradient, glow, 큰 floating AI button
- emoji navigation과 장식 emoji
- 모든 정보 묶음을 독립 card로 감싸는 구조
- 반복 설명, 버전 footer, 홍보성 문구, 불필요한 status pill
- 동일 화면 안의 여러 radius와 shadow 체계

## Success Criteria

- [x] 공통 light/dark tokens가 Orca식 neutral palette와 단일 accent를 사용한다.
- [x] 로그인은 장식 splash 없이 한 화면에서 계정 진입 행동과 보안 경계만 보여준다.
- [x] 시작 가이드는 4단계를 조밀한 설정 surface로 제공하고 현재/완료 상태를 텍스트와
      아이콘으로 함께 전달한다.
- [x] Agent Work의 상태, 자동화, 승인, 최근 대화가 card wall이 아니라 scan 가능한
      row/section hierarchy로 보인다.
- [x] 설정은 버전 장식과 theme card grid 없이 account, appearance, setup, runtime,
      preferences를 일관된 row로 제공한다.
- [x] Calendar AI, Wiki, Calendar, Runner 기능과 기존 test selector가 회귀하지 않는다.
- [x] 1320px 실제 Electron과 768px renderer의 light/dark 화면에서 overflow, 잘림,
      저대비가 없다.

## Edge Cases

- 긴 Workspace, Runner, automation, agent 이름은 한 줄 말줄임 처리한다.
- Runner가 없거나 연결 중이거나 revoked일 때 동일한 레이아웃 안에서 상태가 바뀐다.
- onboarding 오류와 연결 완료 상태가 layout shift 없이 표시된다.
- Calendar AI drawer와 settings/onboarding surface가 작은 창에서 겹치지 않는다.
- reduced motion에서는 화면 전환 이동을 제거한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] neutral token, simplified login, full-surface settings/onboarding,
        row-based control room 계약이 현재 코드에서 실패한다.
- GREEN:
  - [x] 기존 동작과 selector를 보존하는 최소 JSX/CSS 개편을 적용한다.
- REFACTOR:
  - [x] 중복 surface/radius/status styles를 semantic token으로 합친다.

## Acceptance Gates

- [x] 디자인 계약 테스트
- [x] 관련 feature unit tests
- [x] `npm run typecheck`
- [ ] `npm --workspace apps/desktop run test` (release packaging 계약 2건을 제외한 230건 통과)
- [x] `npm run build:desktop`
- [x] 실제 Electron light QA
- [x] 실제 Electron dark QA
- [ ] `npm test`

건너뛴 gate:

- Lighthouse:
  - 인증된 Electron `file://` 제품 표면에 맞는 harness가 없어 실제 Electron layout,
    keyboard, contrast, overflow 검사로 대체한다.

## Implementation Checklist

- [x] Step 1: 현재 화면, 기존 디자인 토큰, Orca 공식 화면과 공개 소스를 감사한다.
- [x] Step 2: anti-slop 구조 계약의 RED를 고정한다.
- [x] Step 3: 공통 neutral token과 login/settings/onboarding/Runner 표면을 구현한다.
- [x] Step 4: Agent Work, Automation, Knowledge의 card wall을 row hierarchy로 정리한다.
- [x] Step 5: 라이트/다크 실제 Electron과 전체 회귀를 검증한다.
- [x] Step 6: 제한된 한 명의 reviewer로 최종 디자인/코드 감사를 수행한다.

## Rollback

React/CSS와 디자인 계약 변경만 되돌리면 기존 표면으로 복귀한다. 데이터 migration,
API 또는 persisted meaning을 바꾸지 않으므로 데이터 rollback은 필요 없다.

## Verification Notes

- Orca primary reference:
  - `https://www.onorca.dev/`
  - `https://github.com/stablyai/orca`
- Audit:
  - Calendar shell은 이미 compact하지만 나머지 제품 표면은 warm card-heavy 스타일이다.
- Design contract:
  - `node --test apps/desktop/tests/orca-product-surfaces-design.test.mjs`
  - 8 passed, 0 failed
- Desktop regression:
  - release packaging 계약을 제외한 Desktop 테스트 231 passed, 0 failed
  - 전체 Desktop 테스트의 release packaging 계약 2건은 기존 상태 그대로 failed
  - Backend 410 passed, Runner 19 passed
- Build:
  - `npm run build:desktop` passed
- Electron:
  - `playwright-orca-shell-calendar.cjs` light/dark passed
  - 로그인, 캘린더, 세션 복원과 safeStorage를 실제 Electron에서 확인
- Renderer visual QA:
  - 1320px light/dark: settings, onboarding, control room, Runner
  - 768px: settings, control room
  - Wiki 1320px/768px light/dark: 실제 노드 81개, overflow 없음, 다크 그래프 대비 확인
  - Wiki 집중 보기 1320px/768px light/dark: 실제 그래프 헤더와 종료 동작, overflow 없음
  - Wiki 그래프 설정 1320px light/dark와 768px: semantic token, shadow 없음, viewport 안 배치
  - 집중 보기의 장식용 pane chrome 제거, 실제 확대/축소/초기화 도구 opacity 1·semantic token 확인
- Existing release gate:
  - `desktop-release-contract.test.mjs`의 packaging/workflow 2건은 현재 package/workflow
    설정이 아직 없어 실패한다. 이번 디자인 변경과 분리된 기존 release safety 작업이다.
- Boot blocker fixed:
  - `electron-updater` CommonJS 모듈의 named ESM import를 호환 import로 수정했고 실제
    Electron cold launch와 restart restore로 확인했다.
- Final design review:
  - 제한된 기존 reviewer 재검토 `PASS / APPROVE`, blockers 없음
  - `.omo/evidence/orca-product-surfaces-anti-slop-redesign-clone-fidelity.md`

## Remaining Risks

- `App.tsx`와 `styles.css`가 큰 단일 파일이어서 시각 변경 범위를 selector 단위로 제한한다.
- 진행 중인 Desktop release safety 변경이 같은 파일에 있으므로 삭제하거나 되돌리지 않고
  typecheck와 전체 회귀에서 함께 검증한다.
- Desktop renderer bundle은 500 kB 경고가 남아 있다. 이번 변경의 기능 오류는 아니며
  후속 code-splitting 작업에서 다룬다.
