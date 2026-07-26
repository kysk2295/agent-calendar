# Plan: Phase 9 Web trust pages

- Date: 2026-07-25
- Owner: Codex
- Work size: Medium | Boundary
- Status: Complete
- Parent: `docs/plans/2026-07-25-phase9-web-landing.md`

## Goal

현재 배포된 Agent Calendar 소개 랜딩에 제품의 실제 데이터 경계와 private beta 상태를
정확히 설명하는 개인정보, 이용정책, 지원 경로를 추가한다. 아직 없는 법률 검토,
지원 이메일, 공개 SLA를 만들어내지 않고 public launch 전에 남은 관문을 명시한다.

## Non-goals

- 법률 자문을 대신하거나 최종 법률 문서라고 주장하지 않는다.
- 가입, 결제, 지원 티켓, 상태 페이지 기능을 새로 만들지 않는다.
- 공개되지 않은 이메일 주소나 사업자 정보를 만들어내지 않는다.
- Desktop, Backend, DB, Runner 동작을 변경하지 않는다.
- Sites 프로젝트를 새로 만들거나 현재 owner-only 접근 수준을 넓히지 않는다.

## Work size

Medium boundary change. 기존 Web 앱에 세 개의 공개 정보 route와 footer navigation을
추가하고, 서버 렌더링 계약·production build·기존 Sites 배포를 함께 검증한다.

## Touched boundaries

- Web routes: `apps/web/app/privacy/**`, `apps/web/app/terms/**`,
  `apps/web/app/support/**`
- Web shared presentation: `apps/web/app/_components/**`,
  `apps/web/app/page.tsx`, `apps/web/app/globals.css`
- Web tests: `apps/web/tests/rendered-html.test.mjs`
- Hosting: existing Sites project only
- Backend, DB, Desktop, Runner: 변경 없음

## Success criteria

- [x] 랜딩 footer에서 개인정보, 이용정책, 지원 페이지로 이동할 수 있다.
- [x] 개인정보 페이지가 Workspace 데이터, Calendar/Work/Wiki/Automation 데이터,
      Runner 경계, 실행 엔진 자격 증명 경계를 실제 제품 계약에 맞게 설명한다.
- [x] 이용정책이 private beta, 사용자 소유 계정/Runner, 승인 관문, 금지 행위,
      가용성 한계를 거짓 SLA 없이 설명한다.
- [x] 지원 페이지가 현재 초대 채널만 존재함을 정직하게 말하고 공개 지원 주소를
      만들어내지 않는다.
- [x] 각 route가 독립적인 title, `main`, heading, 홈 복귀 링크를 서버 렌더링한다.
- [x] narrow viewport에서도 표와 긴 한국어 문장이 수평 overflow를 만들지 않는다.
- [x] production build, policy tests, lint, dependency audit가 통과한다.
- [x] 동일한 Sites 프로젝트에 exact validated source가 새 private production
      version으로 배포된다.

## Edge cases

- JavaScript가 꺼져도 모든 정책 본문과 navigation을 읽을 수 있다.
- 긴 URL, 영문 provider 이름, 한국어 문장이 줄바꿈된다.
- 외부 support/signup/download 환경값이 없어도 가짜 연락처나 링크가 노출되지 않는다.
- 정책 날짜는 현재 버전의 기준일로 표시하고 자동으로 바뀌지 않는다.
- owner-only Sites 접근 수준은 배포 후에도 유지된다.

## Test plan

1. 세 route가 404이고 footer link가 없어 실패하는 서버 렌더링 계약을 추가한다.
2. 공유 policy shell과 세 route, footer navigation을 최소 구현한다.
3. Web tests, lint, production dependency audit, build를 실행한다.
4. existing Sites project에 exact source를 저장·배포하고 상태를 확인한다.

## Acceptance gates

- [x] expected RED route contract
- [x] Web rendered HTML and handoff policy tests
- [x] Web lint
- [x] Web production dependency audit
- [x] Web production build
- [x] existing Sites source/version validation
- [x] owner-only production deployment
- [x] `git diff --check`

## Step-by-step checklist

- [x] Step 1: existing landing, deployment metadata, external trust gaps inspect
- [x] Step 2: route and footer contract RED
- [x] Step 3: shared trust-page shell and three product-accurate pages
- [x] Step 4: local validation
- [x] Step 5: exact source save, private deployment, durable evidence

## Rollback

Sites의 이전 saved version을 재배포하면 된다. 새 route와 footer link는 Web에만 있고
제품 데이터나 인증 계약을 바꾸지 않으므로 데이터 rollback은 필요 없다.

## Remaining risks

- 최종 Privacy/Terms는 public signup 전에 한국 관할과 실제 사업자 정보에 맞춘 법률
  검토가 필요하다.
- 공개 support 주소, SLA, incident status URL은 여전히 외부 운영 관문이다.
- production URL은 owner-only access gate가 먼저 표시된다. 공개 전환은 별도 사용자
  결정과 public signup gate가 필요하다.

## Verification notes

- RED: 기존 배포 build에서 footer link 계약이 실패하고 `/privacy`가 404임을 확인했다.
- Web: production build와 7/7 서버 렌더링·handoff 계약이 통과했다.
- Lint: 오류 없음.
- Production dependency audit: 취약점 0건.
- Browser QA: `/`, `/privacy`, `/terms`, `/support`를 1280, 768, 375px에서 확인했다.
  12개 상태 모두 horizontal overflow와 viewport 밖 요소가 0이고 console
  warning/error가 없었다.
- Sites: exact source `7e4a5987bfe3b0227eb0694ce87fed3714239617`,
  saved version 2, owner-only production deployment 성공.
- Production URL: `https://agent-calendar-app.fond-koi-2054.chatgpt.site`
- Evidence: `docs/operations/evidence/2026-07-25-phase9-web-trust-pages.md`
