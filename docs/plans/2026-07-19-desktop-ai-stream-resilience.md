# Plan: Desktop AI 스트림 복구력 보강

- Date: 2026-07-19
- Owner: Codex
- Work size: Medium
- Status: Verified

## Goal

Calendar AI, Wiki 큐레이터, Agent Work 대화가 스트림 중단이나 마지막 구분자 누락을 만나도 이미 받은 자연어 답변을 잃지 않고, 사용자가 같은 질문을 안전하게 다시 시도할 수 있게 한다. Wiki 근거는 새 질문마다 초기화하고, 선택한 근거 문서를 실제 리더에서 열 수 있어야 한다.

## Non-Goals

- 현재 운영 Wiki 첫 답변/완료가 30초 이내로 확인된 상태에서 Relay, 제공자, Railway 백엔드를 추측으로 변경하지 않는다.
- 로컬 LLM 또는 모바일 전용 UI를 추가하지 않는다.
- API, DB, Electron IPC 계약을 변경하지 않는다.

## Work Size

Desktop React UI와 기존 스트림 소비기 및 테스트만 수정하는 Medium 작업이다. 백엔드/배포 경계는 건드리지 않는다.

## Touched Boundaries

- Backend gateway: 변경 없음
- Backend library: 변경 없음
- DB/migrations: 변경 없음
- Electron bridge: 변경 없음
- React UI: `apps/desktop/src/App.tsx`, `apps/desktop/src/features/chat/**`, `apps/desktop/src/features/agent-operations/**`
- Tests: `apps/desktop/tests/**`
- Docs: 이 계획 문서

## Success Criteria

- [x] Calendar AI가 일부 텍스트 뒤 중단되면 일부 답변과 중단 안내를 함께 보이고, 원래 질문을 입력창에 복원한다.
- [x] Calendar AI가 답변 없이 종료되면 명시적인 실패 안내와 재시도 가능한 질문을 보인다.
- [x] Wiki SSE의 마지막 블록에 빈 줄 구분자가 없어도 자연어 답변과 근거를 반영한다.
- [x] Wiki 새 질문은 이전 근거를 즉시 지우고, 새 근거 버튼은 해당 문서를 리더에서 연다.
- [x] Agent Work가 `accepted`와 일부 답변 뒤 `done` 없이 종료되어도 일부 답변과 연결 오류를 보이고 active 상태에 남지 않는다.
- [x] 운영 Wiki 실측이 첫 delta 10.75초, 근거/완료 24.43초로 30초 목표를 만족한다.

## Edge Cases

- Calendar: 사용자가 요청 중 새 문장을 입력했다면 실패 복구가 새 입력을 덮어쓰지 않는다.
- Wiki: CRLF, 분할 청크, 마지막 구분자 누락, 빈 `sources` 배열을 처리한다.
- Agent Work: 수락 전 실패는 기존처럼 요청을 reject하고, 수락 후 실패는 durable refresh를 시도하면서 부분 텍스트를 보존한다.
- Agent Work: 다른 Delegated Work로 전환하면 이전 Work Conversation의 부분 응답이나 오류가 새 대화에 보이지 않는다.
- Wiki: CRLF 이벤트 구분자가 두 네트워크 청크 사이에서 갈라져도 블록 경계를 복원한다.

## Test Plan

제품 코드보다 테스트를 먼저 작성한다.

- RED:
  - [x] Calendar 부분 delta 뒤 error에서 답변/입력이 보존되는 브라우저 테스트
  - [x] Wiki 마지막 무구분자 done과 근거 열기/이전 근거 초기화 브라우저 테스트
  - [x] Agent Work accepted+delta 뒤 정상 EOF에서 오류 상태로 닫히는 회귀 테스트
  - [x] Agent Work 두 mission 전환 뒤 이전 live state가 보이지 않는 브라우저 테스트
  - [x] Wiki CRLF 구분자를 `\r`/`\n` 사이에서 분할하는 브라우저 테스트
- GREEN:
  - [x] Calendar catch가 부분 답변을 덮어쓰지 않고 빈 입력에만 원문을 복원
  - [x] Wiki 스트림 소비기가 EOF 잔여 블록을 flush하고 구조화된 메타/근거를 전달
  - [x] Agent Work hook이 done 없는 수락 스트림을 중단으로 확정하고 부분 텍스트를 보존
  - [x] Agent Work live state를 mission/controller 소유권으로 격리
  - [x] Wiki 누적 버퍼에서 CRLF를 정규화해 청크 경계 분할을 처리
- REFACTOR:
  - [x] Wiki 블록 소비를 한 함수로 모으고 API 계약은 유지

## Acceptance Gates

- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] 관련 Playwright 스트림 회귀 테스트
- [x] 운영 Wiki 30초 기준 재측정
- [x] 실제 Desktop 패키지/앱 흐름 수동 QA
- [x] `npm test`

건너뛴 gate:

- Gate: `npm run backend:check`
  - Reason: 백엔드 코드는 변경하지 않았고 전체 백엔드 284개 테스트는 `npm test` 안에서 통과했다.

## Implementation Checklist

- [x] Step 1: 운영 Wiki 경로의 첫 delta/근거/완료 지연을 실측한다.
- [x] Step 2: 세 실패 경계를 RED 테스트로 고정한다.
- [x] Step 3: 최소 Desktop 구현으로 각 테스트를 GREEN으로 만든다.
- [x] Step 4: 좁은 테스트부터 전체 Desktop gate와 실제 앱 QA까지 확장한다.
- [x] Step 5: 코드 리뷰에서 발견된 mission 전환/CRLF 분할 경계를 RED→GREEN으로 닫고 acceptance gate를 재실행한다.

## Verification Notes

- Command: 운영 `POST /api/chat/stream` Wiki 복합 질문 실측
  - Result: first delta 10,752ms, first evidence 24,404ms, done 24,429ms, 총 24,431ms, 8 sources, 678자 자연어 답변
- Command: 세 스트림 Playwright 회귀
  - Result: Calendar partial/error/input restore, Wiki undelimited done/evidence reader/stale clear/split CRLF, Agent Work accepted+partial/no-done/mission 전환 뒤 late error 격리 모두 통과
- Command: `npm test`
  - Result: Backend 284/284, Desktop 141/141 통과
- Command: `npm run build:desktop` 및 `npm --workspace apps/desktop run dist:mac`
  - Result: renderer/electron build와 서명된 arm64 app/zip/dmg 생성 성공; notarization 설정은 없어 건너뜀
- Command: `node apps/desktop/tests/packaged-deep-link-smoke.cjs`
  - Result: 최신 Electron 패키지에서 15개 표면, cold/running deep link, 외부 URL 거부 모두 통과
- Command: 독립 코드 리뷰 및 재검토
  - Result: 초기 P1 두 건(CRLF 청크 분할, Work Conversation 상태 혼선)을 수정했고, late-callback 테스트 동기화까지 보강 후 제품 P0/P1/P2 없음

## Remaining Risks

- Risk: 운영 제공자 지연은 세션 상태와 외부 부하에 따라 변동될 수 있다.
  - Mitigation: 현재 정상 baseline은 보존하고, 회귀 시 first-delta/evidence/done을 따로 측정한다.
- Risk: 브라우저 fixture와 실제 Electron 네트워크 종료 방식이 다를 수 있다.
  - Mitigation: Playwright 회귀 뒤 최신 서명 패키지의 Electron surface를 검증했다.
- Risk: 생성된 macOS 배포물은 서명됐지만 notarization 환경이 설정되지 않았다.
  - Mitigation: 로컬 QA에는 영향이 없으며 외부 배포 전 notarization을 별도 release gate로 둔다.
