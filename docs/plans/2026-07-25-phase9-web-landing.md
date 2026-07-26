# Plan: Phase 9 Web landing and trusted handoff

- Date: 2026-07-25
- Owner: Codex
- Work size: Large | Boundary
- Status: Complete — landing and trust pages deployed; public signup/download/legal approval gates remain external
- Parent: `docs/plans/2026-07-24-production-development-roadmap.md`

## Goal

Agent Calendar를 처음 접하는 사람이 일정 중심 제품, Workspace 소유 Runner, Calendar AI,
위임 작업, 보안 경계를 한 번에 이해할 수 있는 한국어 소개 랜딩을 제공한다. 가입과
Desktop 다운로드는 검증된 외부 URL·릴리스 정보가 있을 때만 활성화하고, 준비되지 않은
상태를 성공처럼 보이지 않는다.

## Non-Goals

- Web에 캘린더, 작업 관제, Wiki, 자동화 제어 기능을 복제하지 않는다.
- WorkOS, Railway, GitHub의 실제 production credential을 새로 발급하지 않는다.
- 서명·공증되지 않은 Desktop 또는 Runner 빌드를 공개 다운로드로 제공하지 않는다.
- 결제, 팀 초대, 관리자 화면, Mobile 제품을 이번 슬라이스에 추가하지 않는다.
- Orca의 브랜드, 로고, 카피 또는 터미널 중심 정보 구조를 복제하지 않는다.

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge: 변경 없음
- Web product: 신규 `apps/web/**`
- Hosting: Sites project metadata, validated source version, private production deployment
- Tests: Web handoff policy, build, browser accessibility/responsive checks
- Docs: Phase 9 plan, roadmap status, durable evidence

## Design Read

- Purpose: Desktop 제품을 이해하고 신뢰할 수 있는 가입·다운로드 경로로 이동
- Tone: refined industrial editorial, Orca-like restraint with Agent Calendar warm accent
- Signature: 한 개의 실제 주간 타임라인이 사람 일정과 에이전트 작업의 동시 실행을 설명
- Density: 5/10
- Motion: 2/10, entrance choreography only, reduced-motion safe
- Shape: 6–10px controls, flat sections, thin dividers, no decorative card wall

## Success Criteria

- [x] 첫 화면은 Agent Calendar를 “일정 중심의 에이전트 작업 운영 공간”으로 설명한다.
- [x] 사람 일정과 independently running agent work가 겹칠 수 있음을 실제 타임라인으로
      이해할 수 있다.
- [x] Calendar AI, Work Conversation, Runner ownership, Connected Automation을 제품 용어에
      맞게 설명한다.
- [x] 로그인·다운로드는 HTTPS URL과 검증된 서명/버전/SHA-256 정보가 모두 있을 때만
      활성화된다.
- [x] 준비되지 않은 외부 관문은 `Private beta 준비 중`으로 표시되며 가짜 성공 링크가 없다.
- [x] 사이트에는 인증된 control-plane UI, 토큰, credential, 사용자 데이터가 없다.
- [x] 1280px, 768px, 375px에서 수평 overflow, 가려진 CTA, 읽을 수 없는 카피가 없다.
- [x] 키보드, focus, landmark, heading, reduced motion, color-independent state가 검증된다.
- [x] production build와 owner-only production deployment가 완료된다.

## Edge Cases

- 가입 URL 없음 또는 HTTP URL: CTA를 비활성화한다.
- 다운로드 URL만 있고 SHA/signature/version이 없음: 다운로드를 비활성화한다.
- JavaScript가 꺼짐: 핵심 제품 설명과 준비 상태가 그대로 읽힌다.
- 긴 한국어 줄: 조사·핵심 명사를 한 글자씩 고립시키지 않는다.
- 좁은 화면: Desktop UI를 흉내 낸 다중 column 대신 순서가 보존된 단일 흐름으로 전환한다.
- reduced motion: 등장 애니메이션 없이 즉시 완성된 내용을 표시한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] HTTPS·서명·SHA·버전이 모두 없으면 CTA가 활성화되지 않는 테스트가 실패한다.
  - [x] 제품 용어·랜드마크 계약 테스트가 초기 starter에서 실패한다.
- GREEN:
  - [x] 환경 기반 handoff policy와 서버 렌더링 랜딩을 최소 구현한다.
  - [x] 제품·보안·Runner 설명과 명시적 준비 상태를 구현한다.
- REFACTOR:
  - [x] 반복되는 handoff 상태 표시를 작은 컴포넌트로만 분리한다.

## Acceptance Gates

- [x] Web policy and structure tests
- [x] `npm run build`
- [x] Browser QA at 1280px, 768px, 375px
- [x] Keyboard/focus/reduced-motion QA
- [x] No external request, console error, or horizontal overflow
- [x] Sites source package validation
- [x] Saved source version and private production deployment
- [x] `git diff --check`

건너뛴 gate:

- Public signup:
  - Reason: live WorkOS AuthKit production URL과 dashboard gate가 아직 제공되지 않았다.
- Public Desktop download:
  - Reason: Developer ID notarization과 promoted GitHub stable artifact가 아직 없다.
- Analytics consent:
  - Reason: 이번 버전은 analytics를 전혀 로드하지 않아 consent가 필요한 추적이 없다.

## Implementation Checklist

- [x] Step 1: Sites-compatible Web app initialization and plan
- [x] Step 2: fail-closed handoff policy RED/GREEN
- [x] Step 3: product-specific landing UI and content
- [x] Step 4: build and browser QA
- [x] Step 5: exact source save, deployment, evidence, roadmap update

## Rollback

- Sites의 이전 saved version으로 즉시 재배포한다.
- 외부 가입·다운로드 환경값을 제거하면 사이트는 정보형 private-beta 상태로 fail closed한다.
- Web 배포를 중지해도 Desktop 사용자, Runner, Backend에는 영향이 없다.

## Verification Notes

- RED: `node --test tests/handoff-policy.test.mjs`
  - Result: expected `ERR_MODULE_NOT_FOUND` before the policy implementation.
- Web: `npm test && npm run lint`
  - Result: build passed; 5/5 tests passed; lint passed.
- Production dependency audit: `npm audit --omit=dev --audit-level=high`
  - Result: 0 production vulnerabilities after Next.js patch and constrained transitive overrides.
- Browser QA:
  - Result: 1280, 768, and 375 viewport widths all matched `scrollWidth`; responsive mobile agenda,
    semantic landmarks, visible keyboard focus, and zero browser warnings/errors observed.
- Sites:
  - Result: exact source `7a343174a13b805fa4478670fd036a511d6f2539`, saved version 1,
    owner-only production deployment succeeded at
    `https://agent-calendar-app.fond-koi-2054.chatgpt.site`.
- Evidence:
  - `docs/operations/evidence/2026-07-25-phase9-web-landing.md`

## Remaining Risks

- 제품 동작에 맞춘 Privacy/Terms/Support 페이지는 배포됐다. Public 전환 전 실제
  운영 주체와 연락처를 포함한 최종 법률 검토·승인이 필요하다.
- 실제 도메인, AuthKit signup, notarized download, public status URL은 외부 gate다.
- 전체 개발 의존성 audit에는 scaffold build-tool advisory가 남지만, 배포되는 production
  dependency audit는 0건이다.
