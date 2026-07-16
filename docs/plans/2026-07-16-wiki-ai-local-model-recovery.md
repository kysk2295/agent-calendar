# Plan: 위키 큐레이터 자연어 응답 복구

- Date: 2026-07-16
- Owner: Codex
- Work size: Large / Boundary
- Status: Complete

## Goal

데스크톱 위키 질문 원문을 현재 Telegram에서 사용 중인 `wikicurator` 세션의
provider/model route로 전달한다. 큐레이터의 자연어 답변은 그대로 표시하고,
벡터 검색 결과는 답변을 대신하는 원문 목록이 아니라 클릭 가능한 근거 위키로만
표시한다.

## Non-Goals

- 특정 provider나 model을 애플리케이션에 하드코딩하지 않는다.
- 데스크톱 질문을 Telegram 채팅으로 재전송하지 않는다.
- 검색 결과를 키워드 기반 답변으로 합성하지 않는다.
- 위키 검색·그래프·문서 저장 구조와 DB schema는 변경하지 않는다.

## Touched Boundaries

- Backend gateway: `profile.chat` payload, 공개 SSE fallback, model metadata
- Mac mini Relay bridge: 현재 Telegram 세션 route 상속, streaming 완료 처리
- Hermes agent runtime: OpenAI Codex transport 호환 처리
- Tests: backend 공개 스트림과 Mac mini runtime 회귀 테스트
- Electron bridge / React UI / DB migrations: product-code 변경 없음

## Success Criteria

- [x] 질문 원문만 `wikicurator`의 `profile.chat`에 전달한다.
- [x] 현재 Telegram 큐레이터 세션의 provider/model route를 동적으로 상속한다.
- [x] 운영 응답이 실제 route인 `openai-codex / gpt-5.5`를 보고한다.
- [x] 큐레이터의 자연어 답변을 수정 없이 표시한다.
- [x] 벡터 검색 결과는 별도 근거 태그와 클릭 가능한 위키 버튼으로 표시한다.
- [x] 실패 시 검색 원문을 답변으로 위장하지 않고 간결한 실패 안내를 표시한다.
- [x] 운영 Railway와 실제 데스크톱 renderer 경로에서 end-to-end로 검증한다.

## Edge Cases

- 현재 Telegram 세션이 없으면 임의 model을 추측하지 않고 명시적으로 실패한다.
- assistant 최종 응답이 비어 있거나 확인되지 않으면 성공으로 처리하지 않는다.
- 중간 delta POST가 지연되어도 최종 응답과 complete 전송을 가로막지 않는다.
- watchdog 직후 정상 child exit가 경합하면, 확인된 최종 assistant record가 있을 때만
  성공으로 승격한다.
- 큐레이터 실행 실패 시 근거 위키는 유지하되 답변 영역에는 간결한 재시도 안내만
  표시한다.

## Test Plan

- RED: backend가 `resumeSource: telegram` 없이 job을 만들면 계약 테스트가 실패한다.
- RED: bridge가 전역 프로필의 오래된 route를 사용하거나 질문에 검색 본문을
  주입하면 runtime 테스트가 실패한다.
- RED: delta 전송 지연과 timeout/exit 경합에서 complete가 누락되면 회귀 테스트가
  실패한다.
- GREEN: 질문 원문, 현재 세션 route, 자연어 답변, model provenance, 벡터 근거가
  각각 계약대로 전달된다.
- REFACTOR: 성공 경로와 degraded 경로 모두 model을 추측하지 않는다.

## Acceptance Gates

- [x] `npm run backend:check`
- [x] `npm run test:backend`
- [x] `npm run typecheck`
- [x] `npm --workspace apps/desktop run test`
- [x] `npm run build:desktop`
- [x] Mac mini Relay bridge 전체 테스트
- [x] 운영 Railway 직접 API 검증
- [x] 실제 desktop renderer + 운영 API 검증

## Implementation Checklist

- [x] 질문 원문과 현재 Telegram session 선택을 backend 계약으로 고정한다.
- [x] bridge가 현재 `wikicurator` session의 provider/model route를 상속하게 한다.
- [x] OpenAI Codex용 Hermes transport 오류를 수정한다.
- [x] delta POST 지연과 timeout/exit 경합에서도 complete가 전달되게 한다.
- [x] backend가 실제 completion model만 노출하고 가짜 local model을 추측하지 않게 한다.
- [x] 실패 화면에서 raw 검색 원문을 제거하고 근거 태그만 유지한다.
- [x] Railway 배포와 renderer end-to-end 검증을 완료한다.

## Verification Notes

- Root cause: 모델 전환 자체는 정상적으로 저장되어 있었다. bridge가 현재 Telegram
  session route 대신 오래된 전역 profile route를 사용했고, provider가 답변을 만든
  뒤에도 지연된 delta POST를 기다리느라 complete를 보내지 못했다. timeout과 정상
  child exit의 경합도 간헐 실패를 만들었다. backend는 실패 시 존재하지 않는
  `qwen2.5:7b` metadata를 추측하고 raw 검색 결과를 답변처럼 표시했다.
- Backend focused: `node --test apps/backend/tests/wiki-fallback.test.cjs` — 11/11 PASS.
- Backend full: `npm run test:backend` — 250/250 PASS.
- Desktop: typecheck PASS, tests 138/138 PASS, production build PASS.
- Mac mini: Relay bridge tests 39/39 PASS; Hermes focused tests 10/10 PASS;
  JavaScript syntax와 Python compile PASS.
- Railway deployment: `03dd332f-d401-4d20-a6ff-6d12636d389d` — SUCCESS.
- 운영 직접 API: HTTP 200, `answerMode: llm`, `gatewayFallback: false`,
  `model: gpt-5.5`, 자연어 답변, raw 검색 prefix 없음, 근거 6개.
- 실제 renderer: 운영 API 응답 200, 약 48.2초, 답변 1,381자, 근거 버튼 3개,
  `model: gpt-5.5`, `answerMode: llm`, raw 검색 prefix 없음.
- macOS foreground 자동 클릭은 잠금 화면 때문에 수행하지 못했지만, 동일 Electron
  renderer를 Playwright로 실행해 실제 운영 API와 end-to-end 검증했다.

## Rollback / Fallback

- 큐레이터 실행 실패 시 간결한 재시도 안내와 검색된 근거 위키를 반환한다.
- Mac mini bridge는 LaunchAgent 재시작으로 독립 복구할 수 있다.
- backend 배포는 직전 Railway deployment로 즉시 rollback할 수 있다.

## Remaining Risks

- Mac mini의 bridge/Hermes runtime 수정은 이 저장소 바깥 `~/.hermes`에 있다.
  Hermes 재설치나 업데이트가 덮어쓸 수 있으므로 후속으로 runtime 저장소에
  반영하거나 patch 자동 적용을 영속화해야 한다.
- 큐레이터 응답 시간은 질문과 provider 상태에 따라 약 40~50초가 걸릴 수 있다.
  현재는 정상 streaming 완료를 우선 복구했으며, 지연 최적화는 별도 범위다.
