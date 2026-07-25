# Plan: Workspace-scoped schedule ingest

- Date: 2026-07-25
- Owner: Codex
- Work size: Large / Boundary
- Status: Verified

## Goal

프로덕션 데스크톱에서 텍스트 또는 이미지로 일정을 인식하면, 현재 인증된 Workspace의 통합 일정만 기준으로 충돌을 표시한 검토용 초안을 반환한다. 초안 생성은 일정이나 할 일을 저장하지 않으며, 사용자가 선택해 등록할 때만 기존 Calendar/Task API가 저장한다.

## Non-Goals

- Calendar AI 대화 모델이나 일정 추출 프롬프트를 전면 교체하지 않는다.
- 초안을 서버가 자동 승인하거나 자동 저장하지 않는다.
- 여러 이미지, 문서 파일, 영상 인식으로 입력 범위를 넓히지 않는다.
- 모바일 전용 화면을 이번 단계에서 구현하지 않는다.

## Touched Boundaries

- Backend gateway: 프로덕션 요청 본문 분기와 route dispatch
- Backend library: multipart 파싱, Workspace-scoped 일정 초안 생성
- DB/migrations: 없음
- Electron bridge: 기존 client-v1 프록시 계약 유지
- React UI: 기존 초안 검토·등록 흐름 유지
- Tests: Backend Workspace 격리·무저장 계약, Desktop 검토·등록 계약 및 실제 UI QA
- Docs: route lifecycle, Phase 10 roadmap, 검증 증거

## Success Criteria

- [x] 인증되지 않은 요청은 일정 인식 결과를 받지 못한다.
- [x] multipart/text 요청은 크기 제한 안에서 파싱되고 지원하지 않는 파일은 거부된다.
- [x] 충돌 검사는 세션이 가리키는 Workspace의 통합 일정만 사용한다.
- [x] 다른 Workspace의 같은 시간 일정은 충돌로 노출되지 않는다.
- [x] 인식 요청 전후 일정·할 일 개수가 변하지 않는다.
- [x] 사용자가 데스크톱에서 초안을 선택해 등록한 뒤에만 Calendar API로 일정이 생성된다.
- [x] `/api/assistant/ingest`가 production-disabled 목록에서 제거되고 client-v1에 고정된다.

## Edge Cases

- 본문 없음: 400과 사용자 수정 가능한 메시지를 반환한다.
- 잘못된 multipart boundary: 400으로 닫힌다.
- 지원하지 않는 파일 형식 또는 둘 이상의 이미지: 415/400으로 거부한다.
- OCR/LLM Runner 부재: 성공으로 위장하지 않고 초안 0건과 명시적 warning을 반환한다.
- 종일 일정 또는 종료 시각 없음: 충돌을 추측하지 않는다.
- 외부 캘린더 투영이 비활성화된 Workspace: 내부 일정만으로 완전한 범위 응답을 만든다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] Workspace A/B 일정이 섞이지 않고 인식 호출이 저장하지 않는 테스트
  - [x] multipart text/image 파싱과 잘못된 입력 fail-closed 테스트
  - [x] production registry/client-v1/lifecycle 계약 테스트
- GREEN:
  - [x] bounded raw body를 ingest 전용 파서로 전달한다.
  - [x] 인증 scope로 Unified Calendar 범위를 조회해 초안 충돌을 계산한다.
  - [x] 기존 Desktop 등록 API 이외의 write를 수행하지 않는다.
- REFACTOR:
  - [x] 기존 파서와 중복되는 최소 helper만 공유하고 공개 응답에서 내부 오류를 제거한다.

## Acceptance Gates

- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [x] 실제 Desktop 초안 검토 → Calendar 등록 Playwright QA

건너뛴 gate:

- Gate: 없음
  - Reason:

## Implementation Checklist

- [x] Step 1: ingest 요청 파서와 Workspace 격리 실패 테스트를 추가한다.
- [x] Step 2: Workspace-scoped draft service를 구현한다.
- [x] Step 3: production dispatcher와 route registry를 연결한다.
- [x] Step 4: client-v1 및 lifecycle 기대값을 갱신한다.
- [x] Step 5: 실제 Desktop 검토·등록 시나리오와 전체 회귀를 통과한다.

## Rollback / Fallback

- route registry를 다시 `production_disabled`로 전환하면 legacy unscoped 경로로 떨어지지 않고 안전하게 차단된다.
- OCR/LLM 실행 경로가 준비되지 않은 경우에도 경고와 빈 초안을 반환하며 데이터는 쓰지 않는다.

## Verification Notes

- `npm run backend:check`: passed.
- `node --test tests/phase10-workspace-schedule-ingest.test.cjs tests/phase1-full-gateway-workspace-cutover.test.cjs tests/phase10-client-v1-contract.test.cjs tests/phase10-route-lifecycle.test.cjs`: 18 passed.
- `npm --workspace apps/desktop run test`: 258 passed.
- `npm --workspace apps/runner run test`: 23 passed.
- `npm run typecheck`: passed.
- `npm run build:desktop`: passed; existing Vite large-bundle warning only.
- `node tests/playwright-wiring.cjs`: passed; one ingest, one Calendar create, and the created event was visible in Calendar.
- `npm test`: passed on the final full run — Backend 454, Desktop 258, Runner 23.
- A prior full run exposed one transient disaster-recovery PITR parallel rehearsal failure; its 8 tests passed alone immediately afterward and the unchanged final full run passed.

## Remaining Risks

- Risk: 이미지 OCR은 고객 Runner/relay 가용성에 의존한다.
  - Mitigation: 텍스트 입력은 독립적으로 동작하고, 이미지 실행 경로 부재를 명시적 warning으로 노출한다.
- Risk: 외부 캘린더의 최신성은 마지막 동기화 시점에 의존한다.
  - Mitigation: Unified Calendar가 반환하는 현재 Workspace projection만 사용하고 원격 provider를 ingest 요청 중 직접 호출하지 않는다.
