# Plan: Desktop surface QA stability

- Date: 2026-07-18
- Owner: Codex
- Work size: Medium
- Status: Verified

## Goal

실제 패키징된 Agent Calendar 앱에서 주요 데스크톱 탭과 오버레이를 순회하고, 각 화면의 버튼 계약을 격리된 Playwright 환경에서 실행해 사용자 입력과 서버 상태가 충돌하는 결함을 수정한다.

## Non-goals

- 모바일 전용 화면이나 반응형 모바일 셸을 다시 추가하지 않는다.
- QA 중 실제 사용자 일정, 메일, 위키, 자동화 데이터를 생성·수정·삭제하지 않는다.
- Hermes scheduler API 또는 Electron preload 계약을 변경하지 않는다.

## Work size

Medium. Desktop React 화면과 Desktop Playwright 계약만 변경하며 API·DB·IPC 경계는 유지한다.

## Touched boundaries

- Desktop app: `apps/desktop/src/features/agent-operations/HermesAutomationDashboard.tsx`
- Desktop tests: `apps/desktop/tests/packaged-deep-link-smoke.cjs`
- Specs and plans: `docs/plans/**`

## Success criteria

- [x] 패키징된 `.app`에서 12개 주요 탭, 검색, 설정, Calendar AI 열기/닫기가 렌더링된다.
- [x] Hermes 자동화 수정, 일시정지, 재활성화, 삭제 확인이 요청 계약대로 동작한다.
- [x] 서버 목록 갱신과 사용자 입력이 겹쳐도 사용자가 수정한 필드는 덮어쓰지 않는다.
- [x] 저장 요청 실패 시 편집값과 오류 메시지가 함께 유지된다.
- [x] Desktop typecheck, tests, build와 전체 beta gate가 통과한다.

## Edge cases

- 대시보드 첫 렌더 직후 사용자가 서버 목록 정규화보다 먼저 입력한다.
- 사용자가 한 필드만 수정한 동안 다른 필드는 최신 서버 값으로 채워져야 한다.
- 저장은 성공했지만 후속 목록 갱신이 실패한다.
- 자동화 삭제 뒤 선택된 작업이 사라진다.
- Agent Work 전용 화면은 의도적으로 공통 topbar를 숨긴다.

## Test plan

1. RED: 기존 Hermes 자동화 Playwright 오류 복구 시나리오에서 저장 버튼 비활성화 또는 입력값 덮어쓰기를 관찰한다.
2. GREEN: 필드 단위 dirty 상태를 보존하고 수정하지 않은 값만 서버 상태와 동기화한다.
3. REFACTOR: 패키징된 앱 순회 검증을 기존 deep-link smoke에 추가한다.
4. VERIFY: 자동화 시나리오 반복 실행, 전체 surface-button 묶음, 패키지 앱, beta gate를 실행한다.

## Acceptance gates

- [x] `npm --workspace apps/desktop run typecheck`
- [x] `node apps/desktop/tests/playwright-hermes-automation-dashboard.cjs` 3회 연속
- [x] Desktop surface-button Playwright 묶음
- [x] `npm --workspace apps/desktop run dist:mac`
- [x] `npm --workspace apps/desktop run test:packaged:deep-link`
- [x] `npm run verify:beta`

## Step-by-step checklist

- [x] 실제 패키지 앱 순회 범위와 안전한 비변경 버튼을 정의한다.
- [x] 자동화 오류 복구 시나리오의 입력 덮어쓰기 실패를 재현한다.
- [x] 자동화 편집 폼을 필드 단위 서버 병합으로 수정한다.
- [x] 패키지 재빌드와 전체 회귀를 실행한다.
- [x] 증거, 커밋, 배포 상태를 최종 기록한다.

## Verification notes

- Hermes 자동화 RED: 재로딩 직후 목표를 수정하면 저장 버튼이 비활성화되거나 서버 값이 편집값을 다시 덮어썼다.
- Hermes 자동화 GREEN: 이름·목표·담당 프로필·실행 일정별 dirty 필드를 보존하고, 수정하지 않은 필드만 늦게 도착한 서버 값과 병합했다. 수정·일시정지·재활성화·삭제·오류 보존 시나리오를 3회 연속 통과했다.
- Surface buttons: 에이전트, 캘린더, Calendar AI, 일기, 메일, 다음 7일/칸반, 회고, 설정 3종, 기본함, 오늘, 위키/검색의 격리된 버튼 계약이 모두 통과했다.
- Packaged app: Apple Development 서명된 `.app`에서 캘린더, 오늘, 다음 7일, 기본함, 메일함, 칸반 보드, 주간 회고, 위키, 일기, 에이전트, Hermes 자동화, 위젯, 검색, Calendar AI, 설정을 직접 열었다.
- Full gate: Backend 283/283, Desktop 141/141, Desktop typecheck와 production build가 통과했다.
- Packaging: DMG/ZIP 생성은 성공했다. 배포용 notarization 옵션이 없어 notarization은 건너뛰었다.

## Remaining risks

- macOS 잠금 상태에서는 화면 캡처 기반 Computer Use 관찰을 실행할 수 없다. 실제 Electron `.app` 프로세스를 Playwright로 구동해 대체 검증하며, 잠금 해제 후 육안 스크린샷은 별도 확인이 가능하다.
- 로컬 개발 서버의 Vite HMR WebSocket 포트가 이미 사용 중이면 비치명 경고가 출력될 수 있다.
- 생성된 앱은 Apple Development 서명까지 완료됐지만 notarization은 설정되지 않았다. 현재 Mac의 로컬 실행 QA에는 영향이 없고 외부 배포 전에는 notarization 자격 증명이 필요하다.
