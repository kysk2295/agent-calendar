# Plan: Web landing anti-slop redesign

- Date: 2026-07-25
- Owner: Codex
- Work size: Medium
- Status: Complete
- Parent: `docs/plans/2026-07-25-phase9-web-landing.md`

## Goal

기존 Web 랜딩을 Orca의 절제된 제품 신뢰감과 Agent Calendar Desktop의 중립적 디자인
시스템에 맞게 다시 설계한다. 가짜 캘린더 UI, 과장된 AI 카피, 섹션마다 반복되는 번호와
색상 반전을 제거하고, 실제 제품 화면으로 일정 중심의 운영 흐름을 설명한다.

## Non-Goals

- 제품 인증, 가입, 다운로드의 외부 availability 계약을 변경하지 않는다.
- Web에 Desktop 기능을 복제하지 않는다.
- 가짜 수치, 고객 로고, 후기 또는 출시 일정을 만들지 않는다.
- 생성형 이미지로 실제 제품 UI를 대체하지 않는다.
- Mobile 제품 개발을 시작하지 않는다.

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge: 변경 없음
- React UI: `apps/web/app/page.tsx`, `layout.tsx`, `globals.css`
- Public assets: 실제 Desktop QA 화면의 Web용 복사본
- Tests: Web static design contract와 rendered HTML
- Docs: 이 계획과 QA 증거

## Design Read

- Purpose: 일정, 에이전트 작업, Runner, Wiki AI가 하나의 제품 흐름임을 설명
- Tone: quiet product editorial, cool neutral, one deep-green accent
- Signature: 실제 Unified Calendar와 Work Conversation을 겹치지 않고 큰 제품 이미지로 제시
- Design variance: 6/10
- Motion intensity: 4/10
- Visual density: 3/10
- Shape: media 16px, controls 999px, supporting surfaces 10px

## Success Criteria

- [x] 첫 화면은 비대칭 split이며 한 viewport 안에서 제품과 CTA를 이해할 수 있다.
- [x] hero 제목은 두 줄 이하, 보조 문장은 20어절 이하, CTA 의도는 중복되지 않는다.
- [x] 실제 Calendar, Agent Work, Wiki 화면이 이미지로 렌더링된다.
- [x] fake calendar DOM, section numbering, decorative dot, scroll cue, theme-flip section이 없다.
- [x] 한 개의 accent와 하나의 page theme이 light/dark 양쪽에서 일관된다.
- [x] Runner와 engine 설명은 credentials가 사용자 환경에 남는 실제 계약을 설명한다.
- [x] 가입과 다운로드는 기존 fail-closed handoff policy를 유지한다.
- [x] 1280px, 768px, 375px에서 수평 overflow와 잘린 CTA가 없다.
- [x] reduced motion, keyboard focus, semantic landmark와 이미지 alt가 검증된다.

## Edge Cases

- Signup URL 없음: hero CTA가 링크가 아닌 준비 상태로 보인다.
- Download proof 없음: Footer 또는 release note가 다운로드 성공을 암시하지 않는다.
- Dark mode: 이미지 frame과 본문 대비가 유지되고 별도 검은 섹션으로 뒤집히지 않는다.
- 좁은 화면: split hero와 editorial layouts가 단일 열로 재배치된다.
- 이미지 로딩 실패: alt와 주변 카피만으로도 기능이 이해된다.

## Test Plan

- RED:
  - [x] fake WeekBoard와 번호형 product rows 때문에 실패하는 anti-slop 테스트
  - [x] 실제 제품 이미지, split hero, dark mode 계약이 없어서 실패하는 테스트
- GREEN:
  - [x] 기존 handoff policy를 보존한 최소 landing rewrite
- REFACTOR:
  - [x] 중복 media frame과 copy primitives만 정리

## Acceptance Gates

- [x] focused anti-slop test
- [x] `npm --prefix apps/web test`
- [x] `npm --prefix apps/web run lint`
- [x] Browser QA at 1280px, 768px, 375px, light/dark
- [x] `git diff --check`

## Implementation Checklist

- [x] Step 1: 실제 Desktop surface 세 장을 선택하고 public asset으로 준비한다.
- [x] Step 2: split hero와 제품 서사를 실제 이미지 기반으로 다시 작성한다.
- [x] Step 3: cool-neutral light/dark tokens와 responsive layout을 구현한다.
- [x] Step 4: trust pages가 같은 tokens에서 회귀하지 않는지 검증한다.
- [x] Step 5: 실제 브라우저 QA와 증거를 기록한다.

## Rollback

- 이 redesign 커밋을 되돌리면 기존 Phase 9 landing으로 복원된다.
- public handoff availability는 독립 policy이므로 UI rollback과 무관하게 계속 fail closed한다.

## Remaining Risks

- 제품 screenshot의 QA fixture 문구는 public 출시 전 실제 demo Workspace의 비식별 데이터로
  한 번 더 교체해야 한다.
- Chrome 확장 프로그램이 `html`에 추가한 속성 때문에 개발 모드 hydration 경고가
  관찰됐지만 제품 DOM이나 production build에서 재현되는 오류는 아니었다.
