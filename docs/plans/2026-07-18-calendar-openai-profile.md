# Plan: Calendar AI OpenAI 프로필 전환

- Date: 2026-07-18
- Owner: Codex
- Work size: Large / Boundary
- Status: In progress

## Goal

Calendar AI의 기존 `calendarassistant` Hermes 세션·일정 근거 경계를 유지하면서 자연어 생성 모델을 로컬 Qwen에서 OpenAI Codex GPT-5.5로 전환한다. 실제 Railway/Desktop 질문에서 자연스러운 한국어와 30초 이내 첫 응답을 검증한다.

## Non-Goals

- 일정 검색, 정확 존재 판정, 벡터 DB 또는 Calendar 공개 API 스키마를 변경하지 않는다.
- Wiki Curator 프로필이나 Telegram 세션 설정을 변경하지 않는다.
- Calendar AI에 파일·터미널·메시징 도구 권한을 추가하지 않는다.

## Touched Boundaries

- Backend gateway: 변경 없음; 현재 `calendarassistant` Relay 계약 유지
- Backend library: 변경 없음
- DB/migrations: 없음
- Electron bridge: 변경 없음
- React UI: 변경 없음
- Remote runtime: Mac mini `calendarassistant` Hermes 프로필과 전용 Gateway LaunchAgent
- Tests: Mac mini Relay 전체 테스트, Railway live AI 품질 매트릭스, Desktop live QA
- Docs: 이 계획과 Mac mini 운영 문서

## Success Criteria

- [ ] `calendarassistant`가 `openai-codex` / `gpt-5.5`로 응답한다.
- [ ] 프로필은 도구·메모리·위임을 계속 비활성화하고 구조화된 일정 문맥만 사용한다.
- [ ] 존재/부재/요약/추천/후속 질문이 자연스러운 한국어로 답한다.
- [ ] `다음 금요일` 같은 상대 요일 질문이 실제 단일 날짜 범위를 밝히고 그 날짜만 조회한다.
- [ ] live 품질 매트릭스에서 첫 응답 p90이 30초 이내다.
- [ ] Wiki Curator, Agent Work, Mail 경로에 회귀가 없다.

## Edge Cases

- OpenAI OAuth 만료 또는 rate limit: 로컬 Qwen으로 조용히 전환하지 않고 typed failure와 근거 기반 fallback을 반환한다.
- 기존 Calendar 세션에 Qwen 대화가 남아 있음: 전환 후 새 세션 버전 또는 초기화된 전용 세션으로 모델 문맥 오염을 방지한다.
- 상대 요일 질문이 단순 존재 조회로 잘못 분류됨: 날짜 범위 설명 질문은 요약 의도를 유지한다.
- Gateway 재시작 중 요청: Relay가 일시적인 재시도 가능 실패로 처리하고 가짜 성공을 만들지 않는다.

## Test Plan

이 작업은 원격 런타임 설정 변경이므로 제품 코드 TDD 대신 변경 전/후 계약 검증을 사용한다.

- RED:
  - [x] 현재 Calendar 프로필의 provider/model이 OpenAI 계약과 다름을 확인한다.
- GREEN:
  - [x] 프로필 provider/model을 전환하고 전용 Gateway를 재시작한다.
  - [x] 직접 session chat에서 OpenAI 메타데이터와 자연어 답변을 확인한다.
- REFACTOR:
  - [x] Qwen 전용 warm-up을 Calendar 답변 필수 경로에서 제거하거나 비활성화한다.
  - [x] 운영 문서의 모델·예상 메타데이터·롤백 절차를 실제 상태와 일치시킨다.

## Acceptance Gates

- [ ] Mac mini profile config check
- [ ] Mac mini Relay syntax/full tests
- [ ] Railway health and Relay online check
- [ ] Calendar two-turn live QA
- [ ] `node apps/desktop/tests/ai-quality-matrix-live.cjs`
- [ ] configured Mail live E2E
- [ ] `npm run verify:beta`
- [ ] packaged Desktop smoke QA

건너뛴 gate:

- Gate: 없음
  - Reason: 완료 시 실제 실행 결과를 기록한다.

## Implementation Checklist

- [x] Step 1: 현재 Mac mini Calendar profile/Gateway 모델 계약을 실패 검증하고 백업한다.
- [x] Step 2: `calendarassistant`를 OpenAI Codex GPT-5.5로 전환하되 도구·메모리·위임 금지를 유지한다.
- [x] Step 3: Gateway/Relay와 직접 세션을 검증하고 Qwen warm-up 의존을 정리한다.
- [ ] Step 4: Railway 및 실제 Desktop에서 다양한 질문과 응답시간을 검증한다.
- [ ] Step 5: 전체 회귀, 문서, 커밋·푸시 상태를 확인한다.

## Rollback

- 변경 직전 timestamp 백업의 Calendar profile config 및 LaunchAgent plist를 복원한다.
- `ai.hermes.gateway-calendarassistant`만 재시작하고 Relay/다른 Hermes 프로필은 유지한다.
- Railway 코드 롤백은 필요하지 않으며, 실패 시 정확 근거 기반 Calendar fallback을 유지한다.

## Verification Notes

- Command: 변경 전 production Calendar 두 턴 질문
  - Result: 분류와 최근 대화 문맥은 정상이나 `custom` / `qwen2.5:7b`로 응답했고, 후속 질문은 비자연스러운 혼합 문구와 32.1초 지연을 보였다.
- Command: Mac mini Calendar OpenAI profile contract assertion
  - Result: 예상대로 실패했다. 실제 값은 `provider=custom`, `model=qwen2.5:7b`였다.
- Command: Mac mini direct Calendar session chat
  - Result: `openai-codex` / `gpt-5.5` 설정과 로그인 상태를 확인했다. 도구 없이 첫 delta 약 2.3초, 전체 3초에 자연스러운 한국어 한 문장으로 응답했다.
- Command: Mac mini Relay syntax/full suite
  - Result: Qwen 생성 warm-up을 제거하고 Calendar `bge-m3` 임베딩 keep-alive만 유지했다. 전체 34/34 통과 후 Relay를 재시작했다.
- Command: production AI quality matrix before relative-weekday parser repair
  - Result: Calendar/Wiki/Agent Work 12개 live turn이 통과했고 p90 첫 delta는 10.1초였다. QA에서 `다음 금요일`이 구체 날짜를 밝히지 않는 추가 결함을 발견해 회귀 테스트를 먼저 추가했다.

## Remaining Risks

- Risk: OpenAI provider의 cold turn이 일시적으로 30초를 넘을 수 있다.
  - Mitigation: 첫 delta와 전체 시간 모두 기록하고, 장기 세션 비대화 시 안전한 세션 회전 규칙을 후속 적용한다.
