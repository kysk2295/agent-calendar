# Plan: 포트폴리오 제출용 README

- Date: 2026-08-03
- Owner: Codex
- Work size: Medium
- Status: Verified

## Goal

Agent Calendar 저장소의 첫 화면에서 제품의 문제 정의, 실제 동작 화면, 랜딩 페이지,
핵심 기능, 아키텍처, 기술적 의사결정, 실행·검증 방법을 빠르게 평가할 수 있는
포트폴리오용 루트 README를 제공한다.

## Non-Goals

- 제품 기능이나 UI를 변경하지 않는다.
- 검증되지 않은 성과 수치, 사용자 수, 출시 상태를 주장하지 않는다.
- 공개 배포가 확인되지 않은 URL을 라이브 서비스 링크로 표시하지 않는다.

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge: 변경 없음
- React UI: 변경 없음
- Tests: 기존 검증 명령만 실행
- Docs: 루트 `README.md`, `docs/portfolio/**`, 본 계획

## Success Criteria

- [x] 루트 README가 프로젝트 가치와 구현 범위를 포트폴리오 관점에서 설명한다.
- [x] 실제 렌더링한 랜딩 페이지와 실제 Desktop 제품 화면이 저장소 자산으로 표시된다.
- [x] 확인 가능한 랜딩 페이지 경로와 실행 방법을 제공하고, 미확인 배포 상태는 과장하지 않는다.
- [x] README의 로컬 이미지·문서 링크가 모두 유효하다.

## Edge Cases

- 공개 랜딩 URL이 확인되지 않음: 로컬 실행 링크와 소스 경로를 명시하고 배포 링크를 꾸며내지 않는다.
- 테스트 결과 폴더가 gitignore 대상임: README 전용 자산 경로에 새 캡처를 저장한다.
- 런타임 자격 증명이 없음: UI 캡처는 저장소의 검증된 로컬 QA 경로 또는 기존 실제 화면을 사용한다.

## Test Plan

문서·이미지 자산만 변경하므로 TDD 예외를 적용한다.

- RED:
  - [x] 루트 README가 없어 GitHub 대표 문서와 포트폴리오 진입점이 없음을 확인
- GREEN:
  - [x] 실제 화면 자산과 루트 README 작성
- REFACTOR:
  - [x] 링크·이미지·Markdown 구조 점검 후 중복 문구 정리

## Acceptance Gates

- [x] `npm --prefix apps/web run build`
- [x] `node --test apps/web/tests/rendered-html.test.mjs`
- [x] README 로컬 링크·이미지 대상 존재 검사
- [x] 실제 브라우저에서 랜딩 화면 확인 및 캡처

건너뛴 gate:

- Gate: Backend/Desktop/Widget 전체 테스트
  - Reason: 제품 코드를 변경하지 않는 문서·이미지 전용 작업

## Implementation Checklist

- [x] Step 1: 저장소와 랜딩 페이지의 검증 가능한 사실·링크·화면을 수집한다.
- [x] Step 2: 실제 랜딩 및 제품 화면을 `docs/portfolio/` 자산으로 만든다.
- [x] Step 3: 포트폴리오용 루트 README를 작성한다.
- [x] Step 4: 빌드, 브라우저 QA, 링크·이미지 검사를 실행하고 계획을 완료 처리한다.

## Verification Notes

- Command: `npm run build:web`
  - Result: PASS — vinext가 `/`, `/privacy`, `/support`, `/terms`를 포함한 Web 앱 빌드를 완료했다.
- Command: `node --test apps/web/tests/rendered-html.test.mjs`
  - Result: PASS — 4 tests, 0 failures.
- Command: README 로컬 링크·이미지 검사
  - Result: PASS — 13개 대상을 확인했고 누락 0개였다.
- Command: GitHub Markdown API 렌더링
  - Result: PASS — 이미지 6개, 링크 17개, details 1개와 Mermaid enrichment가 생성됐다.
- Command: 실제 Browser QA (`http://localhost:3003/`)
  - Result: PASS — 핵심 제품 문구와 3개 제품 이미지의 로딩을 확인하고 hero/full-page 캡처를 저장했다.

## Remaining Risks

- Risk: 공개 호스팅 URL이 저장소나 GitHub 메타데이터에 기록되어 있지 않을 수 있다.
  - Mitigation: 확인 가능한 GitHub 저장소와 로컬 랜딩 실행 경로만 표기했다. 공개 배포 후 README 상단에 live URL을 추가한다.
