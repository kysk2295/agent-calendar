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
- [x] 데스크톱 capture turn이 Telegram session DB/transcript를 변경하지 않는다.
- [x] 최근 실제 Telegram 대화만 제한적으로 재사용해 capture context가 무한히
  증가하지 않는다.
- [x] 동일 운영 경로에서 30초 안에 자연어 답변과 근거 태그를 완료한다.

## Edge Cases

- 현재 Telegram 세션이 없으면 임의 model을 추측하지 않고 명시적으로 실패한다.
- assistant 최종 응답이 비어 있거나 확인되지 않으면 성공으로 처리하지 않는다.
- 중간 delta POST가 지연되어도 최종 응답과 complete 전송을 가로막지 않는다.
- watchdog 직후 정상 child exit가 경합하면, 확인된 최종 assistant record가 있을 때만
  성공으로 승격한다.
- 큐레이터 실행 실패 시 근거 위키는 유지하되 답변 영역에는 간결한 재시도 안내만
  표시한다.
- 과거 capture turn이 이미 transcript에 섞여 있어도 새 capture context에서는
  제외한다.
- capture용 agent가 context compression을 수행해도 실제 Telegram session id나
  session store entry를 교체하지 않는다.

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
- [x] 최신 Telegram 세션의 일반 user/assistant 대화를 최대 40개까지 bounded
  context로 만든다.
- [x] capture turn을 session DB가 없는 일회성 agent로 실행한다.
- [x] capture 결과의 file transcript/session metadata 쓰기를 차단한다.
- [x] Mac mini 배포 후 Telegram transcript 불변성과 30초 live gate를 검증한다.

## Verification Notes

- Root cause: 모델 전환 자체는 정상적으로 저장되어 있었다. bridge가 현재 Telegram
  session route 대신 오래된 전역 profile route를 사용했고, provider가 답변을 만든
  뒤에도 지연된 delta POST를 기다리느라 complete를 보내지 못했다. timeout과 정상
  child exit의 경합도 간헐 실패를 만들었다. backend는 실패 시 존재하지 않는
  `qwen2.5:7b` metadata를 추측하고 raw 검색 결과를 답변처럼 표시했다.
- Backend focused: schedule assistant 25/25 PASS, session-turn/wiki focused 25/25 PASS.
- Backend full: `npm run test:backend` — 263/263 PASS.
- Desktop: typecheck PASS, tests 138/138 PASS, production build PASS.
- Mac mini: Relay bridge tests 29/29 PASS; Hermes focused tests 25/25 PASS;
  Hermes gateway full suite는 6,662 PASS / 57 SKIP이며 기존 기준과 동일한 12개만
  실패했다. JavaScript syntax와 Python compile PASS.
- Railway deployment: `a9ead88c-e56d-4bc1-9baf-24e49ae4f811` — SUCCESS.
- 운영 위키 경로: HTTP 200, 12.2초, `answerMode: llm`,
  `openai-codex / gpt-5.5`, 자연어 UniPort BM 답변, 근거 8개.
- 근거 검색: `bge-m3` 1024차원 로컬 벡터 인덱스 829/829 완료,
  `source: wiki-vector-index`, `mode: vector-hybrid`, `indexComplete: true`.
- capture 전후 Telegram message 수는 291로 동일했다. 전체 session 수 증가는 별도
  cron session이었고 Telegram transcript 증가는 없었다.
- 캘린더 회귀: Qwen을 강제로 내린 뒤 Relay 시작 warmup으로 재로딩했고, 운영 질문은
  20.8초에 `answerMode: llm`, `qwen2.5:7b`, 완료 일정 8건을 자연어로 반환했다.
- macOS foreground 자동 클릭은 잠금 화면 때문에 수행하지 못했지만, 동일 Electron
  renderer를 Playwright로 실행해 실제 운영 API와 end-to-end 검증했다.

## Rollback / Fallback

- 큐레이터 실행 실패 시 간결한 재시도 안내와 검색된 근거 위키를 반환한다.
- Mac mini bridge는 LaunchAgent 재시작으로 독립 복구할 수 있다.
- backend 배포는 직전 Railway deployment로 즉시 rollback할 수 있다.

## Remaining Risks

- Hermes capture isolation은 로컬 Hermes 저장소의
  `codex/remote-deploy-integration`에 커밋했다. Mac mini Relay는 git 저장소 밖의
  `~/.hermes/os-runtime`에 있으므로 Hermes 재설치 시 운영 백업 또는 runbook을 통해
  재적용해야 한다.
- 위키 문서를 한 번에 64개보다 많이 변경하면 첫 검색은 부분 벡터 인덱스를 사용하고
  후속 검색에서 나머지를 채운다. 응답 metadata의 `indexComplete`로 이를 구분한다.
- 기존 구현에서 누적된 capture turn은 원본 Telegram transcript에 남아 있다. 새
  구현은 이를 context에서 제외하고 더 이상 추가하지 않으며, 기존 기록의 물리적
  삭제는 데이터 보존 위험 때문에 이 작업의 범위에서 수행하지 않는다.
