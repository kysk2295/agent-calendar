# Plan: README 전체 제품 탭 화면

- Date: 2026-08-03
- Owner: Codex
- Work size: Medium
- Status: Verified

## Goal

README가 Agent Calendar의 실제 패키지 앱에 존재하는 모든 내비게이션 탭을 실제 제품
캡처와 함께 설명한다. 독자는 Calendar 중심 제품 구조와 각 탭의 역할을 한 문서에서
확인할 수 있어야 한다.

## Non-Goals

- 제품 UI나 기능 동작을 이번 문서 작업에서 변경하지 않는다.
- 로컬 개발 서버, 목업, 합성 이미지를 제품 화면 증거로 사용하지 않는다.
- 메일 본문, 인증 토큰 등 공개 저장소에 부적절한 사용자 데이터를 이미지에 포함하지 않는다.

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge: 변경 없음
- React UI: 변경 없음
- Tests: 문서 자산 검증만 수행
- Docs: `README.md`, `docs/product/surfaces/**`, 캡처 재현 스크립트

## Success Criteria

- [x] 실제 패키지 앱의 13개 내비게이션 탭이 각각 캡처된다.
- [x] README가 각 탭의 역할과 실제 화면을 같은 순서로 보여준다.
- [x] 모든 이미지와 문서 링크가 존재하고 깨진 경로가 없다.
- [x] 캡처가 패키지 Electron과 Railway 연결 상태에서 만들어졌다는 근거를 남긴다.
- [x] 공개하면 안 되는 사용자 메일 본문이나 자격 증명이 이미지에 노출되지 않는다.

## Edge Cases

- 작업공간 하위 탭: 접힌 내비게이션을 먼저 확장한 뒤 캡처한다.
- 긴 화면: 창 전체가 아니라 현재 패키지 앱 viewport를 캡처해 README 가독성을 유지한다.
- 민감 데이터: 메일 등 사용자 데이터가 보이면 해당 화면을 공개 자산으로 복사하지 않는다.

## Test Plan

문서와 실제 화면 캡처만 변경하므로 제품 행동 TDD는 적용하지 않는다.

- RED:
  - [x] 저장소 자산 조사에서 캘린더·에이전트·위키 외 탭별 README 이미지가 없음을 확인했다.
- GREEN:
  - [x] 패키지 앱 CDP에서 모든 탭을 순서대로 클릭하고 이미지와 캡처 manifest를 생성한다.
- REFACTOR:
  - [x] README의 기존 제품 화면 섹션을 탭별 갤러리로 정리한다.

## Acceptance Gates

- [x] 패키지 앱 URL이 `file://.../app.asar/dist/index.html`인지 확인
- [x] 캡처 manifest에서 13/13 탭 성공 확인
- [x] README 로컬 링크·이미지 경로 검증
- [x] 생성된 이미지 육안 검토

건너뛴 gate:

- Gate: Backend/Desktop build 및 전체 테스트
  - Reason: 제품 코드와 계약을 변경하지 않는 README·스크린샷 문서 작업이다.

## Implementation Checklist

- [x] Step 1: 실제 내비게이션 탭과 기존 증거 자산 조사
- [x] Step 2: 패키지 앱에서 공개 가능한 탭별 화면 캡처
- [x] Step 3: README에 전체 탭 갤러리와 설명 추가
- [x] Step 4: 링크, 이미지, manifest와 시각 결과 검증

## Verification Notes

- Command: `orca computer get-app-state --app com.agents.calendar --restore-window --json`
  - Result: 실행 중인 1320×824 Agent Calendar 패키지 창과 실제 에이전트 작업 대화를 확인했다.
- Command: CDP `/json/list` on port `9228`
  - Result: `file://.../Agent Calendar.app/Contents/Resources/app.asar/dist/index.html` 페이지를 확인했다.
- Command: `QA_CDP_URL=http://127.0.0.1:9228 node docs/qa/readme-surfaces/2026-08-03/capture-all-tabs.mjs`
  - Result: 패키지 앱의 13/13 탭을 캡처했고 Railway gateway `production` 200과 각 PNG SHA-256을 manifest에 기록했다.
- Command: `codesign --verify --deep --strict apps/desktop/release/mac-arm64/Agent Calendar.app`
  - Result: 서명 검증 통과.
- Command: README 이미지·링크 및 manifest 해시 검증 스크립트
  - Result: 13개 PNG 모두 2640×1584, SHA-256 일치, README 로컬 참조 23개 중 누락 0개.

## Remaining Risks

- Risk: 실제 데이터가 바뀌면 다음 캡처에 새로운 개인 정보가 나타날 수 있다.
  - Mitigation: 재현 스크립트가 계정 이름, Workspace 이메일, Runner 식별자와 개인 일기 기록을 마스킹하며 재캡처 후에도 육안 검토한다.
