# Plan: 위키 AI 벡터 RAG 자연어 응답 복구

- Date: 2026-07-16
- Owner: Codex
- Work size: Large / Boundary
- Status: In progress — vector RAG synthesis

## Goal

사용자의 위키 질문 원문을 `wikicurator` 프로필에 그대로 전달하고, 큐레이터가 생성한 답변을 수정 없이 표시한다. 별도 벡터 검색 결과는 답변을 바꾸는 프롬프트가 아니라 근거 태그와 클릭 가능한 원본 위키로만 연결한다.

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
- [x] 실제 Electron에서 `UniPort BM 요약` 질문이 내부 404 없이 답변된다.
- [x] 운영 `wikicurator`의 `profile.chat`이 사용자 질문 원문을 그대로 받아 자연어 답변을 생성한다.
- [x] 성공 응답은 `answerMode: llm`, 임베딩 모델·벡터 점수, 근거 위키 목록을 함께 반환한다.
- [ ] 실제 Electron 답변이 원문 목록이 아닌 자연어 문장과 근거 위키 링크로 표시된다.

## Edge Cases

- Relay 검색 성공 후 LLM 모델이 없거나 꺼진 경우: `retrieval-degraded` 답변을 반환한다.
- 검색 근거가 없는 경우: LLM을 호출하지 않고 no-retrieval을 반환한다.
- LLM이 응답했지만 빈 텍스트인 경우: 근거 기반 fallback을 유지한다.
- 큐레이터 실행 실패: 실패를 정직하게 표시하되 검색 결과 원문 나열을 큐레이터 답변으로 위장하지 않는다.

## Test Plan

- RED:
  - [x] `/api/chat/stream` 위키 요청이 실제 로컬 모델 대신 프로필명만 전송하면 실패한다.
  - [x] 질문을 변경하거나 `profile.chat`이 아닌 모델 API로 보내면 실패한다.
- GREEN:
  - [x] 검색 근거와 로컬 모델을 `chat.completions` Relay에 보내고 담당 에이전트 메타데이터를 보존한다.
  - [x] `wikicurator`의 응답 본문을 그대로 반환하고 별도 벡터 근거를 함께 보낸다.
- REFACTOR:
  - [x] 기존 Relay helper를 재사용하고 위키 전용 중복 경로는 만들지 않는다.

## Acceptance Gates

- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] 실제 Electron 위키 질문

## Implementation Checklist

- [x] Step 1: 위키 스트림 모델/프로필 혼동을 RED 계약으로 고정한다.
- [x] Step 2: 위키 합성을 실제 로컬 모델 Relay로 연결한다.
- [x] Step 3: 실패 fallback과 전체 회귀를 검증한다.
- [x] Step 4: main 배포 후 Electron에서 실제 질문을 확인한다.
- [x] Step 5: 질문 원문을 운영 `wikicurator` profile chat으로 전달한다.
- [ ] Step 6: 자연어 답변·인용·근거 위키를 main 배포 후 실제 Electron에서 확인한다.

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
- Railway deployments: `2015ff2e-a09c-45ba-8068-d21ecf55c550`, `2ad6ee29-e4ff-43e1-bdb9-65e2607c32a2`
  - Result: SUCCESS. 실제 로컬 모델 라우팅과 지연 fallback을 순차 배포했다.
- Actual Electron: `UniPort BM 요약`
  - Result: PASS. 기존 `model 'wikicurator' not found` 404가 재발하지 않았고, 로컬 모델 지연 시 `wikicurator · 검색 fallback`과 출처 3개가 표시되며 요청이 정상 종료됐다.
- RED/GREEN: `node --test --test-name-pattern='wiki stream sends the unchanged question' apps/backend/tests/wiki-fallback.test.cjs`
  - Result: RED `chat.completions`에서 GREEN `profile.chat`; payload는 `profile: wikicurator`와 사용자 질문 한 개만 포함하고 `model`·검색 본문·시스템 프롬프트를 포함하지 않는다.
- UI RED/GREEN: `node apps/desktop/tests/playwright-wiki-graph-ask.cjs`
  - Result: SSE의 벡터 근거가 초기 로컬 검색 근거를 대체하고, 질문 원문만 전송하며 큐레이터 답변과 클릭 가능한 정본 위키를 함께 표시한다.
- Regression gates
  - Result: backend 250 tests, desktop 138 tests, backend syntax, desktop typecheck/build, focused Playwright PASS.

## Remaining Risks

- Risk: Mac mini Relay에 구성된 로컬 모델 자체가 오프라인일 수 있다.
  - Mitigation: 검색 근거 기반 degraded 답변을 정상 사용자 응답으로 유지한다.
- Risk: 현재 운영 검증에서는 로컬 모델이 제한 안에 답하지 않아 자연어 합성 대신 검색 fallback이 사용됐다.
  - Mitigation: 내부 오류나 무한 대기 없이 8초 내 검색 근거와 출처를 반환하며, 모델이 복구되면 동일 경로에서 자연어 합성을 사용한다.
