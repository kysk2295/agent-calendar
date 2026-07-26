# Plan: 음성 아침 브리핑 수직 슬라이스

- Date: 2026-07-23
- Owner: Codex
- Work size: Large
- Status: In progress

## Goal

캘린더 AI에서 한 번의 클릭 또는 음성 질문으로 오늘의 일정·할 일 브리핑을 요청하고, AI의 최종 답변을 한국어 음성으로 들을 수 있게 한다. 음성 질문은 기존 캘린더 대화 흐름으로 들어가 후속 질문을 이어갈 수 있어야 한다.

## Non-Goals

- 이번 작업에서 백그라운드 시각 예약과 macOS 깨우기/자동 재생은 구현하지 않는다.
- OpenAI Realtime, Claude, ElevenLabs 같은 외부 음성 제공자를 새로 연결하지 않는다.
- 전체 장기 기억 저장 정책이나 모델 선택 UI를 재설계하지 않는다.

## Touched Boundaries

- Backend gateway: 기존 `/api/chat/stream` 계약을 그대로 사용한다.
- Backend library: 변경 없음.
- DB/migrations: 변경 없음.
- Electron bridge: 변경 없음. Chromium 음성 인터페이스를 사용한다.
- React UI: 캘린더 AI 대화창의 브리핑·음성 듣기·음성 재생 상태.
- Tests: 음성 도메인 단위 테스트와 Playwright 사용자 흐름.
- Docs: 본 계획.

## Success Criteria

- [ ] 사용자가 `아침 브리핑`을 누르면 오늘 기준의 구조화된 브리핑 요청이 바로 전송된다.
- [ ] 지원 환경에서 마이크로 말한 한국어 질문이 동일한 캘린더 AI 대화로 전송된다.
- [ ] 음성으로 시작한 요청의 최종 답변이 스트리밍 완료 후 한 번만 낭독된다.
- [ ] 음성 인식 미지원·권한 오류가 대화창 안에서 이해 가능한 상태로 표시된다.

## Edge Cases

- 음성 인식 미지원: 마이크 버튼을 비활성화하고 텍스트 질문은 계속 사용할 수 있게 한다.
- 인식 결과가 비어 있음: 요청을 전송하지 않고 대기 상태로 돌아간다.
- 스트리밍 실패: 오류 답변을 중복 낭독하지 않고 기존 재시도 입력을 보존한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [ ] 브리핑 프롬프트와 낭독 텍스트 선택 단위 테스트.
  - [ ] 브리핑 버튼·마이크 질문·최종 음성 재생 Playwright 테스트.
- GREEN:
  - [ ] 음성 도메인 모듈과 최소 React 연결.
- REFACTOR:
  - [ ] 브라우저 음성 객체 접근과 상태 문구를 대화창 내부에 국소화한다.

## Acceptance Gates

- [ ] `npm run backend:check`
- [ ] `npm run test:backend`
- [ ] `npm run typecheck`
- [ ] `npm --workspace apps/desktop run test`
- [ ] `npm run build:desktop`
- [ ] `npm test`

건너뛴 gate:

- Gate:
  - Reason:

## Implementation Checklist

- [ ] Step 1: 음성 브리핑 프롬프트와 낭독 선택 규칙을 고정한다.
- [ ] Step 2: 대화창에 아침 브리핑과 마이크 상호작용을 연결한다.
- [ ] Step 3: 스트리밍 완료 뒤 한국어 TTS를 한 번만 실행한다.
- [ ] Step 4: 자동 아침 실행·외부 실시간 음성·장기 기억으로 가는 후속 구조를 기록한다.

## Verification Notes

- Command:
  - Result:

## Remaining Risks

- Risk: Chromium의 음성 인식 지원 여부와 macOS 마이크 권한은 설치 환경에 따라 다르다.
  - Mitigation: 런타임 지원 탐지와 명확한 미지원/오류 상태를 제공한다.
- Risk: 앱이 닫혀 있으면 아침 브리핑이 자동 실행되지 않는다.
  - Mitigation: 다음 단계에서 Electron 스케줄러와 macOS 알림/깨우기 정책을 별도 경계로 설계한다.
