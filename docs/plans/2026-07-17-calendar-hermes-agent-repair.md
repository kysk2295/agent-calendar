# Plan: Calendar AI Hermes Agent 수리

- Date: 2026-07-17
- Owner: Codex
- Work size: Large / Boundary
- Status: Complete

## Goal

Calendar AI가 일정의 날짜·시간·제목 조건을 먼저 정확히 판별하고, 관련 일정만 근거로 전용 Hermes 대화 세션에서 자연스러운 한국어 답변을 실시간 스트리밍한다. 무관한 일정 때문에 없는 일정을 있다고 답하거나, Relay 응답을 다 받은 뒤 한 번에 표시하는 현상을 제거한다.

## Non-Goals

- Wiki Curator의 검증된 `agent.chat` 및 `wiki.search` 동작은 변경하지 않는다.
- Calendar AI가 일정을 자동 생성·수정·삭제하도록 권한을 넓히지 않는다.
- 외부 캘린더 공급자나 DB 스키마를 교체하지 않는다.
- 로컬 모델 자체를 재학습하거나 Telegram 메시지를 중계하지 않는다.

## Touched Boundaries

- Backend gateway: `apps/backend/app/railway-gateway-server.js`
- Backend library: `apps/backend/app/lib/schedule-assistant.js`, Relay agent/search adapter
- DB/migrations: 없음
- Electron bridge: 필요 시 Calendar 대화 ID 전달 계약만 수정
- React UI: 기존 SSE 소비기가 증분 delta를 정상 누적하는지 검증; 필요 시 최소 수정
- Remote Relay/Hermes: Mac mini Calendar 전용 `agent.chat` 세션과 `bge-m3` 일정 검색 작업
- Tests: Backend schedule/Relay 계약, Desktop Calendar AI Playwright
- Docs: 이 계획과 Mac mini 운영 문서

## Success Criteria

- [x] 같은 날 무관한 일정만 있을 때 “화성 출장” 같은 미등록 일정은 없다고 답하고 무관한 근거를 붙이지 않는다.
- [x] 오늘/내일/이번 주뿐 아니라 명시 날짜, 다음 주, 다음 달, 연·월 질문을 해석한다.
- [x] Calendar 검색 메타데이터에 `hash-fallback`이 남지 않고, 정확 필터 또는 Mac mini `bge-m3` 검색만 사용한다.
- [x] 자연어 생성은 범용 `chat.completions`가 아니라 안정적인 Calendar 전용 Hermes `agent.chat` 대화 ID를 사용한다.
- [x] 후속 질문은 같은 Calendar 세션 문맥을 이어가며, 원 질문과 구조화된 관련 일정만 모델 경계에 전달한다.
- [x] 첫 `delta`를 최종 완료 전에 브라우저로 전달한다.
- [x] 정상 live 질문은 30초 안에 완료된다.
- [x] 실제 데스크톱 앱에서 존재/부재/날짜/추천/후속 질문을 검증한다.

## Edge Cases

- 날짜 범위에는 일정이 있지만 제목·시간 조건이 다름: 관련 일정 0건으로 처리한다.
- 질문에 날짜가 없음: 현재 보기 필터를 우선하고, 없으면 안전한 기본 범위를 사용한다.
- 정확히 일치하는 일정이 없음: LLM 호출 여부와 무관하게 부재 사실을 바꾸지 못하게 한다.
- 제목 일부, 띄어쓰기, 한국어 조사, 오전/오후 시간이 포함됨: 정규화 후 비교한다.
- Relay 또는 Hermes가 오프라인/timeout: 관련 일정 기반의 정직한 fallback과 typed failure를 반환한다.
- `bge-m3` 검색이 실패: 정확 필터 결과를 유지하고 embedding 장애를 성공 메타데이터로 가장하지 않는다.
- 클라이언트가 연결을 닫음: 진행 중 Relay 요청을 중단하고 메시지 저장을 완료로 기록하지 않는다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] 동일 날짜의 무관한 일정이 존재해도 미등록 일정 질문의 sources가 0이고 “없음”으로 답하는 테스트
  - [x] 명시 날짜·다음 주·다음 달 범위 해석 테스트
  - [x] Calendar 스트림이 `chat.completions` 대신 Calendar `agent.chat`을 enqueue하고 완료 전 delta를 쓰는 테스트
  - [x] Calendar Relay payload가 안정적인 대화 ID와 구조화된 일정 문맥을 검증하는 테스트
  - [x] production 검색이 `hash-fallback`을 성공 검색으로 사용하지 않는 테스트
- GREEN:
  - [x] 정확 조건 필터와 날짜 파서 최소 구현
  - [x] 범용 Relay session adapter와 Calendar 전용 agent/search 작업 구현
  - [x] 서버 SSE의 증분 전달 및 안전 fallback 구현
- REFACTOR:
  - [x] Wiki/Calendar가 공유하는 Relay 이벤트 처리를 도메인별 정책과 분리하되 기존 Wiki 계약은 유지

## Acceptance Gates

- [x] focused Backend tests
- [x] remote Relay focused/full tests
- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] Calendar AI Playwright wiring + packaged desktop live QA
- [x] Railway health/Relay online 확인
- [x] `npm test`

건너뛴 gate:

- Gate: 없음
  - Reason: 완료 시 실제 실행 결과를 기록한다.

## Implementation Checklist

- [x] Step 1: 질문 날짜·제목·시간 조건과 관련 일정 판정 계약을 테스트로 고정한다.
- [x] Step 2: 정확 조건 필터를 적용하고 무관 근거 및 전역 “없다고 말하지 말라” 규칙을 제거한다.
- [x] Step 3: Calendar 전용 Hermes session/search Relay 계약과 증분 SSE를 구현한다.
- [x] Step 4: Mac mini에 Calendar 프로필·Gateway/Relay를 배포하고 `bge-m3` 검색을 활성화한다.
- [x] Step 5: Railway를 배포하고 실제 API 및 Desktop에서 다양한 질문과 응답시간을 검증한다.
- [x] Step 6: 전체 회귀를 확인하고 `main`에 커밋·푸시한다.

## Rollback

- Railway는 직전 성공 deployment로 재배포한다.
- Mac mini Relay/프로필은 배포 전 timestamp 백업으로 복원하고 LaunchAgent를 재시작한다.
- 새 Calendar `agent.chat` feature flag를 끄면 정확 필터 기반 fallback만 유지되며, 기존 범용 Qwen 경로로 자동 복귀시키지는 않는다.

## Verification Notes

- Command: production Calendar AI 실질문 진단
  - Result: “내일 오후 3시 화성 출장” 질문이 무관한 `근무` 1건을 근거로 존재한다고 답했다. 검색은 `hash-fallback`, 생성은 `chat.completions`의 `qwen2.5:7b`, 스트림은 완료 후 단일 delta였다.
- Command: Railway 환경 및 코드 경계 점검
  - Result: embedding/Ollama 설정이 없어 hash embedding이 사용되며, 일정 유무 모순 검사는 질의 관련성이 아니라 sources 전체 존재 여부를 기준으로 했다.
- Command: `npm run backend:check && npm run test:backend`
  - Result: 통과. Backend 272/272.
- Command: Mac mini Relay syntax/full suite
  - Result: 통과. Relay 35/35. Calendar 전용 `calendar.search`, `agent.chat`, `bge-m3` 상시 로드 계약 포함.
- Command: production `/api/chat/stream` 실질문 QA
  - Result: 부재 9.7초, 존재 10.6초, 임의 날짜 8.3초, 추천 25.0초, 완료율 27.5초, 후속 질문 25.0초. 추천·완료율·후속 질문은 `calendarassistant`/`qwen2.5:7b`/`bge-m3`, 정확 조회는 `exact-filter`로 확인.
- Command: packaged `Agent Calendar.app` Computer Use + `node apps/desktop/tests/playwright-chat-schedule-qa.cjs`
  - Result: 실제 Calendar AI 입력·스트리밍·최종 답변 렌더링 확인. “내일 오후 3시 화성 출장”은 한 문장으로 미등록 응답. Playwright wiring도 `/api/chat/stream` 1회, `/api/assistant/ask` 0회로 통과.
- Command: `npm test`
  - Result: 통과. Backend 272/272, Desktop 138/138.

## Remaining Risks

- Risk: 장기 대화 세션이 커지면 응답시간이 다시 늘어날 수 있다.
  - Mitigation: Calendar 전용 대화 ID를 보기/사용자 단위로 제한하고, 필요 시 세션 회전 규칙을 후속으로 둔다.
- Risk: 7B 로컬 모델의 자유 생성은 표현이 매번 조금 달라질 수 있다.
  - Mitigation: 정확 존재 조회는 날짜·제목·시간 사실과 길이·언어 검사를 통과해야 하며, 실패 시 근거 기반 한 문장으로 복구한다. 추천·요약에는 상위 6개 근거만 전달한다.
