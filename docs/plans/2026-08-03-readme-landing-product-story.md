# Plan: README와 랜딩 제품 이야기 교정

- Date: 2026-08-03
- Owner: Codex
- Work size: Medium
- Status: Verified

## Goal

Agent Calendar의 README와 공개 웹 화면이 권위 PRD의 현재 제품 약속인 `나를 이해하고
기억하며 필요한 일을 실제로 수행하는 캘린더`를 같은 언어와 정보 위계로 설명한다.

## Non-Goals

- Desktop 제품 기능이나 Backend API를 이번 작업에서 변경하지 않는다.
- 실제로 구현되지 않은 Second Brain 원문 분석을 완료된 기능처럼 주장하지 않는다.
- 기존 웹 랜딩의 navigation, 공개 배포 handoff, 개인정보·이용정책·지원 route를 바꾸지 않는다.
- 새 이미지나 장식용 대시보드 카드를 만들지 않는다.

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge: 변경 없음
- React UI: `apps/web/app/page.tsx`, `apps/web/app/globals.css`
- Tests: `apps/web/tests/anti-slop-landing.test.mjs`, `apps/web/tests/rendered-html.test.mjs`
- Docs: 루트 `README.md`, `apps/web/README.md`

## Success Criteria

- [x] 루트 README가 첫 고객, 제품 이유, 핵심 루프, 저장소 구조, 실행·검증 방법을 설명한다.
- [x] 웹 README가 generic `vinext-starter`가 아니라 Agent Calendar 웹 앱을 설명한다.
- [x] 랜딩의 hero와 `왜 만들었나`가 사용자 이해·기억·작업·보고의 현재 제품 약속을 보여준다.
- [x] Runner는 첫 제품 가치가 아니라 보안·소유권 설명의 하위 영역에 남는다.
- [x] 기존 실제 Desktop 스크린샷, 디자인 토큰, 반응형·다크모드·reduced motion을 유지한다.
- [x] 공개 handoff와 trust route 회귀 없이 웹 테스트와 빌드가 통과한다.

## Edge Cases

- 작은 화면: 긴 한국어 제목이 가로 스크롤이나 잘림 없이 줄바꿈된다.
- 다크모드: 새 섹션이 기존 token만 사용해 동일한 대비를 유지한다.
- JavaScript 또는 배포 handoff 부재: 제품 설명은 SSR되고 다운로드 링크는 계속 fail-closed다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] 랜딩 source에 `why` 섹션과 현재 제품 약속이 있어야 하는 계약 테스트를 추가하고 실패를 확인한다.
  - [x] SSR HTML에 사용자 이해·기억·작업 환류 문구가 있어야 하는 테스트를 추가하고 실패를 확인한다.
- GREEN:
  - [x] README와 랜딩 문구·구조·CSS의 최소 구현으로 집중 테스트를 통과한다.
- REFACTOR:
  - [x] 기존 UI token과 반응형 규칙을 재사용하고 중복 문구를 정리한다.

## Acceptance Gates

- [x] `npm --prefix apps/web test`
- [x] `npm run build:web` (`apps/web`의 `npm test` 선행 build로 실행)
- [x] `npm run lint:web`에 대응하는 `apps/web`의 `npm run lint`
- [x] 실제 빌드 HTML에서 새 섹션과 기존 handoff fail-closed 확인
- [x] production build HTML/CSS 직접 Playwright 렌더로 desktop/mobile 레이아웃 확인

건너뛴 gate:

- Gate: Backend/Desktop 전체 테스트
  - Reason: 이번 변경은 웹 랜딩과 Markdown 문서에 한정되고 해당 경계를 변경하지 않는다.

## Implementation Checklist

- [x] Step 1: 현재 제품 언어를 고정하는 RED 테스트 추가
- [x] Step 2: 루트 README와 웹 README 교체
- [x] Step 3: hero, 왜 만들었나, 제품 루프와 후속 feature copy 교정
- [x] Step 4: 반응형·다크모드 포함 웹 검증

## Verification Notes

- Command: `node --test apps/web/tests/anti-slop-landing.test.mjs apps/web/tests/rendered-html.test.mjs`
  - Result: 새 UI 구현 전 `why` 계약이 예상대로 실패했다. SSR test는 build artifact 부재도 함께 보고했다.
- Command: `npm ci` in `apps/web`
  - Result: 웹 lockfile 기준 504 packages 설치. npm audit는 기존 dependency tree의 15 vulnerabilities를 보고했다.
- Command: `npm test` in `apps/web`
  - Result: production build 성공, 32/32 test 통과.
- Command: `npm run lint` in `apps/web`
  - Result: exit 0. 변경 밖 기존 test의 unused import warning 1건.
- Command: production build worker fetch + Playwright `setContent`/built CSS injection
  - Result: 1440px와 390px 모두 `scrollWidth === viewportWidth`, `why` 섹션과 3개 항목 렌더 확인.
  - Artifacts: `/tmp/agent-calendar-web-desktop.png`, `/tmp/agent-calendar-web-mobile.png`.
- LSP:
  - Result: TypeScript/CSS LSP가 timeout 또는 사용자 거절로 설치되지 않아 fresh diagnostics는 얻지 못했다. build, ESLint와 tests로 대체 검증했다.

## Remaining Risks

- 기존 제품 스크린샷 안의 문구는 이번 웹 copy 변경과 완전히 일치하지 않을 수 있다.
  - Mitigation: 스크린샷은 `실제 Desktop 화면`으로 명시하고 제품 약속은 주변 본문에서 과장 없이 설명한다.
- `apps/web` dependency audit가 15 vulnerabilities를 보고했다.
  - Mitigation: 이번 copy/UI 작업과 분리해 dependency 호환성 검토 후 안전한 upgrade plan으로 처리한다.
