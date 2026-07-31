# Plan: 빈 Workspace Calendar AI 시작 가이드 정직성

- Date: 2026-07-31
- Owner: Codex
- Work size: Medium
- Status: Verified

## Goal

빈 Workspace의 시작 가이드에서 Calendar AI 단계가 실제로 사용할 수 있을 때만 준비 완료가 되고, 준비되지 않았을 때 사용자가 무엇을 준비해야 하는지와 Calendar AI 화면을 여는 방법을 명확히 알 수 있게 한다.

## Non-Goals

- Calendar AI 답변 생성기나 일정 도우미를 다시 설계하지 않는다.
- Wiki 단계와 Runner 등록 흐름을 변경하지 않는다.
- 새로운 backend API, 응답 스키마, DB 마이그레이션을 추가하지 않는다.

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge: 변경 없음
- React UI: `apps/desktop/src/features/onboarding/**`, 필요하면 기존 `App.tsx` Calendar AI 열기 wiring만 최소 조정
- Tests: `apps/desktop/tests/onboarding-readiness.test.mjs`, Calendar AI CTA wiring contract
- Docs: 이 계획 문서

## Success Criteria

- [x] 대화 ID만 존재하는 상태는 Calendar AI 준비 완료로 계산하지 않는다.
- [x] 동기화 완료된 Google Calendar 또는 명시적인 `calendarAiAvailable` 신호가 있으면 Calendar AI 단계와 N/4 진행률이 갱신된다.
- [x] 준비되지 않은 단계는 한국어로 준비 안 됨과 해결 방법을 표시하며 Railway만을 요구하지 않는다.
- [x] 단계 CTA는 Calendar AI 화면과 대화 패널을 연다.
- [x] 기존 Calendar AI 답변 정직성 라벨(`coverageAugmented`, `llm-augmented`) 경로는 유지된다.

## Edge Cases

- 대화 레코드 ID만 있고 런타임 또는 동기화된 캘린더가 없는 경우: 준비 안 됨으로 유지한다.
- Google 소스가 연결됐지만 아직 동기화되지 않은 경우: Calendar AI 준비 완료로 계산하지 않는다.
- 명시적인 Calendar AI availability가 true인 경우: 캘린더가 비어 있어도 준비 완료로 계산한다.
- 동기화된 Google Calendar가 있는 경우: 별도 LLM 신호가 없어도 현재 규칙 기반 fallback을 사용할 수 있으므로 준비 완료로 계산한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] 대화 ID 단독 false-ready를 막는 readiness 테스트
  - [x] 동기화 완료 캘린더/명시 availability의 ready 및 N/4 테스트
  - [x] 준비 안 됨 한국어 해결 안내와 Calendar AI CTA wiring 테스트
- GREEN:
  - [x] readiness 조건과 단계 문구를 최소 변경하고 기존 CTA wiring을 명시적으로 보존
- REFACTOR:
  - [x] 중복 조건을 읽기 쉬운 로컬 불리언으로만 정리

## Acceptance Gates

- [x] `node --test apps/desktop/tests/onboarding-readiness.test.mjs`
- [x] Calendar AI CTA wiring contract test
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm --workspace apps/desktop run build`

건너뛴 gate:

- Gate: backend gates와 전체 monorepo `npm test`
  - Reason: backend/runner 경계와 계약은 변경하지 않는다. Desktop 전체 테스트와 build를 우선 acceptance gate로 사용한다.
- Gate: live Calendar AI manual QA
  - Reason: 실제 Google OAuth 및 사용자 소유 LLM/Runner 자격 증명이 필요한 잔여 검증으로 완료 보고에 기록한다.

## Implementation Checklist

- [x] Step 1: 현재 readiness 및 App CTA wiring을 추적하고 false-ready 경계를 테스트로 고정한다.
- [x] Step 2: 정직한 ready 조건과 한국어 상태/복구 문구를 최소 구현한다.
- [x] Step 3: CTA가 Calendar 화면과 대화 패널을 여는 계약 및 답변 정직성 라벨 보존을 검증한다.
- [x] Step 4: Desktop typecheck, 테스트, build를 통과시키고 검증 노트를 갱신한다.

## Verification Notes

- Command: `node --test tests/onboarding-readiness.test.mjs` (RED)
  - Result: 11개 중 2개가 의도한 이유로 실패했다. 대화 ID가 false-ready를 만들었고, 동기화된 Google Calendar fallback이 아직 ready로 계산되지 않았다.
- Command: `node --test tests/onboarding-readiness.test.mjs tests/communication-domain.test.mjs`
  - Result: 17/17 통과. readiness/CTA 계약과 기존 Calendar AI 답변 정직성 메타데이터 경로를 함께 확인했다.
- Command: `npm run typecheck`
  - Result: renderer와 Electron TypeScript 검사 통과.
- Command: `npm --workspace apps/desktop run test`
  - Result: Desktop 329/329 통과. 병렬 Vite 테스트의 기존 포트 경고만 있었고 실패는 없었다.
- Command: `npm run build` (`apps/desktop`)
  - Result: renderer와 Electron production build 통과. Vite의 기존 500 kB chunk 경고만 남았다.
- Command: `node tests/playwright-first-user-journey.cjs`
  - Result: 통과. OAuth fixture 동기화 뒤 4/4, Calendar AI CTA가 Unified Calendar와 대화 패널을 열고 시작 가이드로 복귀해 완료되는 흐름을 관찰했다.

## Remaining Risks

- Risk: `calendarAiAvailable`이 서버에서 명시적으로 제공되지 않는 환경은 동기화 완료 Google Calendar의 규칙 기반 fallback에 의존한다.
  - Mitigation: 대화 ID를 availability로 오인하지 않고 UI에서 캘린더 동기화 또는 AI 실행 환경 준비 방법을 함께 안내한다.
- Risk: 실제 모델 응답 품질과 실계정 OAuth 성공은 fixture 기반 Playwright로 완전히 증명할 수 없다.
  - Mitigation: 실계정 Google OAuth와 사용자 소유 로컬/Runner LLM은 live manual residual로 남긴다.
