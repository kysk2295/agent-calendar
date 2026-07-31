# Plan: Empty-workspace Wiki onboarding

- Date: 2026-07-31
- Owner: Codex
- Work size: Medium
- Status: Verified

## Goal

빈 Workspace의 Wiki 시작 단계를 실제 로컬 Vault 또는 준비된 Workspace 지식 소스가 연결된 경우에만 준비됨으로 표시한다. 준비되지 않은 사용자는 `LLM_WIKI_VAULT` 경로 설정 또는 앱 안의 파일 추가로 바로 이동할 수 있고, 연결 성공은 4단계 진행률에 반영된다.

## Non-Goals

- Obsidian 그래프, 검색, 질문 흐름을 재설계하지 않는다.
- Calendar AI 또는 Runner 설정 흐름을 변경하지 않는다.
- 다중 테넌트 Wiki 기능이나 예시 문서를 새로 만들지 않는다.

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge: 변경 없음; 기존 `/api/wiki`의 성공한 로컬 Vault 메타데이터만 사용
- React UI: `App.tsx`, Wiki 시작 가이드와 Wiki 빈 소스 안내
- Tests: 데스크톱 onboarding readiness 및 정적 UI copy contract
- Docs: 이 계획

## Success Criteria

- [x] 단순 `active` 상태나 식별 정보가 없는 객체는 Wiki 준비 상태가 되지 않는다.
- [x] 실제 등록되어 `ready`인 지식 소스 또는 성공적으로 스캔된 `local-wiki` Vault만 준비 상태가 된다.
- [x] 미설정 상태에서 `LLM_WIKI_VAULT`, 앱 안의 파일 추가, 누락 경로/오프라인 상태를 정직하게 설명한다.
- [x] Wiki 연결 성공 뒤 준비 수가 4단계 진행률에 반영되고 다음 미완료 단계로 이동할 수 있다.

## Edge Cases

- 지식 소스 등록은 되었지만 아직 ingest 전인 `active` 상태: 준비되지 않음.
- `ready` 문자열만 있는 가짜/불완전 소스 객체: 준비되지 않음.
- 로컬 Wiki 응답에 `source: local-wiki`가 있지만 요청 실패 또는 `wikiRoot`가 없음: 준비되지 않음.
- revoked/error/disabled 소스만 존재: 준비되지 않음.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] active/불완전 소스와 ready 실제 소스를 구분하는 readiness 테스트
  - [x] 성공한 로컬 Vault와 누락 경로 응답을 구분하는 readiness 테스트
  - [x] CTA, 미설정/오프라인 안내, 4단계 진행률을 고정하는 UI copy contract 테스트
- GREEN:
  - [x] 기존 Wiki 응답과 지식 소스 배열을 사용하는 최소 readiness/표현 연결
- REFACTOR:
  - [x] Wiki source 판정을 작은 helper로 유지하고 판정 조건을 이름으로 명시

## Acceptance Gates

- [x] `node --test apps/desktop/tests/onboarding-readiness.test.mjs`
- [x] `npm run typecheck`
- [x] 관련 온보딩 최소 UI surface 테스트
- [x] `npm run build:desktop`

건너뛴 gate:

- Gate: Backend tests/build/full suite
  - Reason: API, DB, Electron 계약은 바꾸지 않고 기존 Desktop 응답을 표현하는 작업이다.
- Gate: `npm --workspace apps/desktop run test:ui:phase8-session-truth`
  - Reason: Electron bundle을 만든 뒤 두 번 실행했지만 현재 공유 개발 환경에서 `electronApplication.firstWindow`가 30초 안에 열리지 않아 시작 전에 종료됐다. 같은 호스트의 parent worktree Electron/Vite 세션은 다른 작업자의 상태이므로 종료하지 않았다.

## Implementation Checklist

- [x] Step 1: readiness 및 UI copy 계약을 RED로 추가한다.
- [x] Step 2: 실제 Wiki source 판정과 App 입력을 구현한다.
- [x] Step 3: 시작 가이드와 Wiki 빈 화면의 CTA/오프라인 문구 및 4단계 진행률을 구현한다.
- [x] Step 4: 대상 테스트, typecheck, 관련 UI surface gate를 통과시킨다.

## Verification Notes

- Command: `node --test apps/desktop/tests/onboarding-readiness.test.mjs`
  - Result: 11 passed. Vite dep-scan이 종료 중 outdated request 경고를 출력했지만 명령은 exit 0이고 모든 Node 테스트가 통과했다.
- Command: `npm run typecheck`
  - Result: renderer와 Electron TypeScript 검사 통과.
- Command: `node --test apps/desktop/tests/orca-product-surfaces-design.test.mjs apps/desktop/tests/orca-quiet-desktop-design.test.mjs`
  - Result: 19 passed.
- Command: `npm run build:desktop`
  - Result: renderer production build와 Electron build 통과. 기존 500 kB chunk 경고만 있음.
- Command: `npm --workspace apps/desktop run test:ui:phase8-session-truth`
  - Result: Electron `firstWindow` timeout으로 2회 미실행; 제품 assertion에 도달하지 못함.

## Remaining Risks

- Risk: `LLM_WIKI_VAULT`는 프로세스 시작 환경이므로 앱 안에서 직접 경로를 저장하지 않는다.
  - Mitigation: 가이드가 이 경계를 명시하고 앱 안의 Workspace 파일 추가를 같은 단계의 실행 가능한 대안으로 제공한다.
