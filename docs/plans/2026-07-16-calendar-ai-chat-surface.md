# Plan: 캘린더 AI 채팅 표면 복원

- Date: 2026-07-16
- Owner: Codex
- Work size: Large
- Status: In progress — deployed runtime recovery

## Goal

채팅 FAB를 캘린더 AI 전용 질문·일정 추천 표면으로 복원한다. 에이전트 실행 원문이나 일반 런타임 채팅 기록은 패널에 노출하지 않고, 모든 텍스트 입력을 캘린더 AI로 보낸다.

## Non-Goals

- 에이전트 작업 관제 화면과 Work Conversation의 실행 기록은 삭제하지 않는다.
- 기존 일정 초안 확인·등록 흐름은 변경하지 않는다.
- 저장된 과거 일반 채팅 데이터나 실행 기록을 DB에서 삭제하지 않는다.

## Touched Boundaries

- Backend gateway: 캘린더 FAB로 명시된 스트림 요청을 일정 어시스턴트로 라우팅
- Backend library: 저장·공개 채팅 레코드에 캘린더 대상(`target`) 보존
- DB/migrations: 변경 없음
- Electron bridge: 변경 없음
- React UI: 최근 실행 카드 제거, 일정 어시스턴트 기록만 hydrate, 캘린더 전용 view 전송
- Tests: 백엔드 라우팅 계약, React 계약, Playwright 사용자 흐름
- Docs: 이 계획 및 검증 결과

## Success Criteria

- [x] 채팅 패널에 `runs` 기반 실행 카드와 내부 Mission 원문이 보이지 않는다.
- [x] 저장된 채팅 중 명시적으로 `target: calendar`인 기록만 패널에 복원된다.
- [x] 질문형이 아닌 텍스트도 FAB에서 보내면 일정 어시스턴트가 처리한다.
- [x] 기존 일정 질문과 일정 초안 등록 흐름이 유지된다.
- [ ] 실제 FAB의 `/api/chat/stream` 경로가 Mac mini Relay의 캘린더 로컬 LLM을 사용한다.
- [ ] 로컬 LLM 또는 Relay 실패 시에도 계산된 일정 답변을 반환한다.

## Edge Cases

- 과거 일반 채팅: DB에는 유지하되 캘린더 AI 패널에서만 숨긴다.
- 비질문형 텍스트: 키워드 추측 없이 명시적 `calendar` view로 라우팅한다.
- 이미지 첨부: 기존 `/api/assistant/ingest` 경로를 유지한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] 일반 실행 기록과 run 카드가 캘린더 채팅에 보이면 실패하는 Playwright 테스트
  - [x] FAB 요청의 view가 캘린더 전용이 아니면 실패하는 계약 테스트
  - [x] 비질문형 캘린더 view 요청이 런타임으로 전달되면 실패하는 백엔드 테스트
  - [ ] FAB 스트림 경로가 Relay 캘린더 로컬 LLM 작업을 만들지 않으면 실패하는 백엔드 테스트
- GREEN:
  - [x] ChatDrawer에서 runs 의존성을 제거하고 일정 기록만 hydrate한다.
  - [x] FAB 스트림 body와 게이트웨이 라우터에 `calendar` view 계약을 연결한다.
- REFACTOR:
  - [x] 사용하지 않는 run 카드 props·CSS·테스트 경로만 정리한다.

## Acceptance Gates

- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] `npm test`
- [x] `node apps/desktop/tests/playwright-chat-calendar-only.cjs`

## Implementation Checklist

- [x] Step 1: 세 가지 회귀를 RED 테스트로 고정한다.
- [x] Step 2: React 채팅 표면을 캘린더 AI 전용으로 축소한다.
- [x] Step 3: Railway 스트림 라우팅을 명시적 캘린더 view로 연결한다.
- [x] Step 4: 실제 Electron에서 패널과 일정 응답을 확인한다.
- [x] Step 5: 검증 결과와 남은 위험을 기록한다.
- [ ] Step 6: FAB 스트림과 일정 JSON API의 로컬 LLM Relay 경로를 통합한다.
- [ ] Step 7: 메인 배포 후 실제 Railway 캘린더 질문을 검증한다.

## Verification Notes

- RED: `node apps/desktop/tests/playwright-chat-calendar-only.cjs`
  - Result: 일반 기록·내부 Mission 노출과 캘린더 전용 문구 부재를 각각 확인한 뒤 GREEN.
- RED: `node --test --test-name-pattern="calendar view routes" apps/backend/tests/schedule-assistant.test.cjs`
  - Result: 비질문형 입력이 런타임 경로로 빠지는 실패를 확인한 뒤 GREEN.
- `npm run backend:check`
  - Result: PASS.
- `npm run test:backend`
  - Result: PASS, 245 tests.
- `npm run typecheck`
  - Result: PASS.
- `npm --workspace apps/desktop run test`
  - Result: PASS, 137 tests. 포트 24678 사용 중 경고는 비차단.
- `npm run build:desktop`
  - Result: PASS.
- `npm test`
  - Result: PASS, backend 245 + desktop 137.
- `node apps/desktop/tests/playwright-chat-calendar-only.cjs`
  - Result: PASS. 캘린더 전용 기록·view·문구와 내부 기록 비노출 확인.
- `node apps/desktop/tests/playwright-chat-surface-buttons.cjs`
  - Result: PASS.
- `node apps/desktop/tests/playwright-chat-send.cjs`
  - Result: PASS.
- `node apps/desktop/tests/playwright-chat-schedule-qa.cjs`
  - Result: PASS.
- 실제 Electron 화면
  - Result: PASS. 채팅 패널에서 Mission/wiki/runtime 기록 비노출, 캘린더 질문 칩·입력·전송 컨트롤 확인.
- 독립 시각 QA
  - Result: 기능 무결성 PASS, 한국어/CJK 가독성 PASS.

## Remaining Risks

- Risk: `target`이 없던 오래된 일정 Q&A 기록은 패널에서 숨겨진다.
  - Mitigation: 앞으로의 캘린더 AI 대화는 `target: calendar`로 저장되며, 과거 오분류된 내부 프롬프트 노출 방지를 우선한다.
