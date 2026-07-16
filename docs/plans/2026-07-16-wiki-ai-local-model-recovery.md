# Plan: 위키 AI 로컬 모델 복구

- Date: 2026-07-16
- Owner: Codex
- Work size: Large / Boundary
- Status: In progress

## Goal

위키 질문이 `wikicurator` 프로필명을 모델로 오인해 404를 반환하지 않도록 한다. 검색된 위키 근거를 실제 로컬 LLM 모델로 합성하고, 모델 실패 시에도 내부 오류 대신 근거 기반 답변과 출처를 보여준다.

## Non-Goals

- 위키 검색·그래프·문서 저장 구조는 변경하지 않는다.
- `wikicurator` 담당 에이전트 정체성은 제거하지 않는다.
- Hermes 위임 작업 실행 엔진이나 프로필 설정은 변경하지 않는다.

## Touched Boundaries

- Backend gateway: 위키 Relay 합성 payload와 공개 SSE fallback
- Backend library: 기존 Relay chat completion 계약 재사용
- DB/migrations: 변경 없음
- Electron bridge: 변경 없음
- React UI: 변경 없음
- Tests: 위키 공개 스트림 Relay 계약 및 실패 fallback
- Docs: 이 계획과 운영 검증 기록

## Success Criteria

- [x] 위키 Relay 합성은 `wikicurator`가 아닌 실제 로컬 LLM 모델을 전송한다.
- [x] UI와 응답 메타데이터는 담당 에이전트를 `wikicurator`로 유지한다.
- [x] 로컬 LLM 실패 시에도 검색 근거 기반 답변과 출처를 반환한다.
- [x] 로컬 LLM이 멈춰도 8초 이내에 검색 근거 기반 답변으로 전환한다.
- [ ] 실제 Electron에서 `UniPort BM 요약` 질문이 내부 404 없이 답변된다.

## Edge Cases

- Relay 검색 성공 후 LLM 모델이 없거나 꺼진 경우: `retrieval-degraded` 답변을 반환한다.
- 검색 근거가 없는 경우: LLM을 호출하지 않고 no-retrieval을 반환한다.
- LLM이 응답했지만 빈 텍스트인 경우: 근거 기반 fallback을 유지한다.

## Test Plan

- RED:
  - [x] `/api/chat/stream` 위키 요청이 실제 로컬 모델 대신 프로필명만 전송하면 실패한다.
- GREEN:
  - [x] 검색 근거와 로컬 모델을 `chat.completions` Relay에 보내고 담당 에이전트 메타데이터를 보존한다.
- REFACTOR:
  - [x] 기존 Relay helper를 재사용하고 위키 전용 중복 경로는 만들지 않는다.

## Acceptance Gates

- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [ ] 실제 Electron 위키 질문

## Implementation Checklist

- [x] Step 1: 위키 스트림 모델/프로필 혼동을 RED 계약으로 고정한다.
- [x] Step 2: 위키 합성을 실제 로컬 모델 Relay로 연결한다.
- [x] Step 3: 실패 fallback과 전체 회귀를 검증한다.
- [ ] Step 4: main 배포 후 Electron에서 실제 질문을 확인한다.

## Verification Notes

- Command: `node --test --test-name-pattern='wiki relay synthesizes retrieval' apps/backend/tests/wiki-fallback.test.cjs`
  - Result: RED. Relay payload의 `model`이 `undefined`이고 `profile: wikicurator`만 존재함을 확인한 뒤 GREEN.
- Command: `node --test apps/backend/tests/wiki-fallback.test.cjs`
  - Result: PASS, 9 tests.
- Command: `npm run backend:check && npm run test:backend`
  - Result: PASS, backend 249 tests.
- Command: `npm run typecheck`; `npm --workspace apps/desktop run test`; `npm run build:desktop`
  - Result: PASS, desktop 138 tests와 production build 완료.
- Command: `node --test --test-name-pattern='wiki relay returns retrieval fallback before' apps/backend/tests/wiki-fallback.test.cjs`
  - Result: RED 5.28초 대기 후 GREEN 1.18초. 운영 UI에서는 최대 8초 뒤 retrieval fallback으로 전환한다.

## Remaining Risks

- Risk: Mac mini Relay에 구성된 로컬 모델 자체가 오프라인일 수 있다.
  - Mitigation: 검색 근거 기반 degraded 답변을 정상 사용자 응답으로 유지한다.
