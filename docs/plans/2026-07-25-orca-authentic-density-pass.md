# Plan: Orca-authentic Desktop density pass

- Date: 2026-07-25
- Owner: Codex
- Work size: Medium
- Status: Complete

## Goal

Agent Calendar Desktop의 공통 셸, 시작 가이드, Agent Work Control Home에서 아직
남아 있는 이중 프레임, 과도하게 큰 데스크톱 컨트롤, 넓게 펼친 진행 표시를 제거한다.
Orca의 실제 제품 화면처럼 작은 행, 한 겹의 경계, 짧은 진행 막대, 중립적인 도구
크롬을 사용하되 Agent Calendar의 캘린더 중심 정보 구조와 terracotta 의미 강조는
유지한다.

## Non-goals

- Backend, DB, Workspace 격리, Runner 또는 자동화 계약을 변경하지 않는다.
- 화면 이름, 내비게이션 순서, 기존 `data-testid`와 키보드 동작을 바꾸지 않는다.
- Orca의 로고, 브랜드 문구, 작업트리 중심 정보 구조를 복제하지 않는다.
- Web landing 또는 Mobile UI를 변경하지 않는다.

## Work size

Medium. Desktop의 공통 셸 CSS, 시작 가이드 CSS, Agent Work CSS와 디자인 계약
테스트를 변경하지만 API, Electron IPC, 저장 데이터 의미는 건드리지 않는다.

## Touched boundaries

- Desktop React: 기존 마크업과 접근성 속성 유지
- Desktop styling: `styles.css`, `onboarding.css`, `agent-workspace.css`
- Tests: Orca 시각 밀도 계약과 기존 디자인 계약
- Docs: 이 계획과 실제 화면 검증 증거

## Design read

- Mode: 기존 IA와 브랜드를 보존하는 Desktop product redesign
- Reference: Orca sidebar navigation, onboarding progress, compact task composer
- Design variance: 4
- Motion intensity: 2
- Visual density: 7
- Shape: 6px controls, row surfaces are flat
- Color: neutral light/dark surfaces, terracotta only for Agent Calendar meaning

## Success criteria

- [x] Sidebar logo and search are navigation chrome, not a floating branded input.
- [x] Onboarding progress is a compact left-aligned bar cluster with one active bar.
- [x] Agent delegation uses one visual frame instead of a panel containing another input.
- [x] Desktop Agent Work controls are 30-36px tall; touch layouts retain 44px targets.
- [x] Approval and task rows remain keyboard accessible and retain semantic status color.
- [x] Light/dark representative screens have no clipping, horizontal overflow, or low contrast.

## Edge cases

- Korean labels and long workspace names remain readable at 768px.
- The delegate textarea can grow without moving the send action outside the frame.
- Mobile and narrow renderer layouts keep 44px interaction targets.
- Reduced motion removes progress-width transitions.

## Test plan

1. Add a focused density contract and confirm it fails against the current double-frame,
   full-width progress, and 44px desktop control rules.
2. Apply the smallest CSS changes that satisfy the contract.
3. Update earlier design contracts only where the new explicit contract supersedes them.
4. Run focused tests, Desktop tests, typecheck, and production build.
5. Capture real light/dark Desktop screens and inspect representative widths.

## Acceptance gates

- [x] Focused Orca density contract
- [x] Existing Orca product-surface design contracts
- [x] Desktop test suite
- [x] Desktop typecheck
- [x] Desktop production build
- [x] Real light/dark visual QA
- [x] `git diff --check`

## Step-by-step checklist

- [x] Audit current UI and Orca official screenshots/source.
- [x] Freeze the new density rules in a failing test.
- [x] Implement shared shell, onboarding, and Agent Work refinements.
- [x] Run automated verification.
- [x] Capture and inspect real Desktop output.
- [x] Record evidence and remaining risks.

## Rollback

Revert the three CSS changes and their focused design contract. There is no data, API,
auth, or persisted-state rollback.

## Remaining risks

- `styles.css` and `agent-workspace.css` remain large legacy files. This pass is limited
  to authoritative selectors already protected by design contracts.
- A compact desktop target is not a touch target. The narrow breakpoint must continue
  to restore 44px minimum controls.
- The renderer bundle remains about 596.8 kB and keeps Vite's existing 500 kB warning.
  This visual pass did not add runtime dependencies or JavaScript.

## Verification notes

- Focused design contracts: 34 passed, 0 failed.
- Desktop tests: 255 passed, 0 failed.
- Typecheck and production Desktop build: passed.
- Control Home light/dark QA: 1280px, 768px, and 375px, no console errors or
  horizontal overflow.
- First-run guide light/dark QA: 1320px and 768px, compact progress bars and one
  current setup action visible.
- AuthKit Electron fixture: safeStorage and restart session restoration passed in both themes.
- Evidence: `docs/operations/evidence/2026-07-25-orca-authentic-density.md`.
