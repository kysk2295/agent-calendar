# Orca 실제 제품 UI 디슬롭 검증

- Date: 2026-07-25
- Scope: Desktop Calendar, onboarding, Runner, Wiki, Settings
- Plan: `docs/plans/2026-07-25-orca-actual-ui-deslop.md`
- Result: PASS

## 적용 기준

공개 Orca 제품 화면과 토큰을 기준으로 다음 시각 계약을 적용했다.

- light: `#fff`, `#fafafa`, `#f5f5f5`, `#e5e5e5`, `#171717`
- dark: `#0a0a0a`, `#171717`, `#262626`,
  `rgb(255 255 255 / .07)`
- 220px 사이드바, 40px 상단바, 30px 컨트롤
- 장식용 gradient, blur, glow, 그림자 제거
- 중첩 카드를 행, 구분선, 여백 기반의 평평한 작업 표면으로 전환
- 브랜드 색상은 주 행동과 실제 상태에만 제한

## 변경 범위

- `apps/desktop/src/main.tsx`
  - 기존 스타일 뒤에 최종 제품 polish 레이어를 명시적으로 연결했다.
- `apps/desktop/src/orca-product-polish.css`
  - 232 pure LOC의 제한된 최종 레이어로 Calendar shell, onboarding, Runner,
    Wiki, Settings를 같은 중립 디자인 시스템에 맞췄다.
- `apps/desktop/tests/orca-product-surfaces-design.test.mjs`
  - import 순서, LOC 한도, 토큰, 장식 금지, 주요 화면 평면화 계약을 회귀
    테스트로 고정했다.
- `apps/desktop/tests/playwright-workos-authkit-login-e2e.cjs`
  - 시작 가이드 rail의 현재 의미 기반 준비 상태를 검증하도록 갱신했다.
- `apps/desktop/tests/playwright-phase5-knowledge-v2.cjs`
  - 축소된 작업공간 탐색에서 Wiki 메뉴를 여는 현재 UI 흐름을 반영했다.

## 수동 QA 증거

실제 Electron 앱을 구동해 다음 산출물을 직접 확인했다.

- Calendar light:
  `apps/desktop/test-results/orca-shell-calendar/01-calendar.png`
- Calendar dark:
  `apps/desktop/test-results/orca-shell-calendar-dark/01-calendar.png`
- Settings light:
  `apps/desktop/test-results/orca-shell-calendar/03-settings.png`
- Onboarding light:
  `apps/desktop/test-results/phase8-google-calendar-oauth/02-first-run-guide.png`
- Onboarding 768px:
  `apps/desktop/test-results/phase8-google-calendar-oauth/02b-first-run-guide-768.png`
- Onboarding dark:
  `apps/desktop/test-results/phase8-google-calendar-oauth-dark/02-first-run-guide.png`
- Runner enrollment:
  `apps/desktop/test-results/phase2-runner-enrollment/setup-code-qr.png`
- Wiki answer:
  `apps/desktop/test-results/phase5-knowledge-v2/01-workspace-a-answer.png`

확인 결과:

- light/dark에서 셸, rail, pane의 대비와 경계가 유지된다.
- 768px 시작 가이드에서 수평 잘림이나 겹침이 없다.
- Runner QR은 실제 등록 시나리오에서 디코드된다.
- Wiki의 Workspace 격리와 출처 상태가 평면 UI에서도 유지된다.
- Settings는 카드 벽 대신 계정 행과 구분선 중심으로 읽힌다.

## 검증 결과

- 디자인 회귀 테스트 RED:
  - polish import 부재로 예상된 실패를 확인했다.
- 디자인 회귀 테스트 GREEN:
  - 11/11 PASS.
- `npm run build:desktop`
  - PASS. TypeScript 검사, renderer build, Electron build 포함.
- Orca shell Electron E2E light/dark
  - PASS.
- Google Calendar OAuth/onboarding Electron E2E light/dark
  - PASS. 초기 오류, 재시도, state 보호, 동기화, 재시작 포함.
- Runner enrollment Electron E2E
  - PASS. QR, fingerprint, capabilities, 재연결, rotation, revoke 포함.
- Knowledge v2 Electron E2E
  - PASS. Workspace A/B 격리, revoked source, 재시작 포함.
- `npm --workspace apps/desktop run test`
  - PASS, 261/261.
- `git diff --check`
  - PASS.
- Static/security scan
  - N/A. 저장소에 별도 스캐너가 구성되어 있지 않다.

## 테스트 중 발견해 갱신한 오래된 가정

- 시작 가이드는 동기화 완료 문구를 rail에 중복 노출하지 않고 `준비됨` 상태를
  표시한다. 실제 연결·동기화 메시지 검증은 그대로 유지했다.
- 현재 탐색 구조에서는 좁은 화면의 Wiki가 더보기 아래에 있다. Knowledge v2
  Electron 시나리오가 실제 메뉴를 먼저 열도록 갱신했다.

## 남은 위험

- 기존 `styles.css`는 약 6,800줄의 과거 규칙을 포함한다. 이번 변경은 회귀 위험을
  제한하기 위해 232 pure LOC의 최종 레이어로 격리했다. 전면적인 CSS 모듈 분리는
  별도 구조 작업이 필요하다.
- Vite는 renderer JavaScript chunk 598.66kB에 대해 500kB 초과 경고를 낸다.
  빌드는 성공했으며 이번 CSS 변경에서 생긴 경고는 아니지만 후속 번들 분리가
  필요하다.
- 테스트 환경에서 WebSocket 24678 포트 사용 중 경고가 간헐적으로 보이나 관련
  시나리오와 전체 테스트는 통과했다.
