# Plan: Runner 의존성 분리와 모바일 진입 방향

- Date: 2026-07-29
- Owner: Codex
- Work size: Large / Boundary
- Status: Draft — 방향 결정 대기

## Goal

Calendar AI와 Wiki AI를 사용자 Runner 없이 동작하게 만들어 모바일에서 제품이 성립하게
한다. 에이전트 작업 실행은 지금처럼 사용자가 소유한 Runner에 남긴다.

## 배경 — 왜 이 계획이 필요한가

현재 구조에서는 사용자의 컴퓨터가 켜져 있어야 AI 기능이 동작한다.
[workspace-inference-broker.js:156](../../apps/backend/app/lib/workspace-inference-broker.js)의
추론 경로는 `connection_state === 'connected'`인 Runner가 없으면 폴백 없이 실패한다.

그 결과 다음이 모두 Runner에 묶여 있다.

- 에이전트 작업 실행
- Calendar AI
- Wiki AI
- 자동화 실행 (`fix: route automations through workspace runners`, d150d66)

노트북 사용자는 덮으면 Runner가 끊기므로 사실상 상시 가동 기기(맥미니 등)가 필요하다.
자동화는 사용자가 보지 않을 때 도는 것이 존재 이유인데, 정확히 그 시간에 기기가 꺼져
있을 확률이 가장 높다. 모바일 앱을 목표로 하는 이상 이 전제는 유지될 수 없다.

이 구조는 버그가 아니라
[production-agent-calendar-platform.md](2026-07-24-production-agent-calendar-platform.md)의
확정 결정("Compute and AI accounts: 고객이 Runner 호스트와 AI 계정을 소유한다")을 따른
결과다. 같은 문서가 Calendar AI에 대해서는 "GPT를 우선 대화 모델로 연결"이라고 적었으나
구현 기본값은 `runner`로 남아 이 부분은 계획과 구현이 어긋나 있다.

## 확정된 방향

| 기능 | 실행 위치 | 근거 |
| --- | --- | --- |
| 에이전트 작업 | 사용자 Runner (유지) | 길고 무거우며 로컬 파일 접근이 필요하다. 구독 정액제가 유리하다. |
| Calendar AI | Runner 비의존 | 짧은 대화. 폰에서 즉답이 필요하다. |
| Wiki AI | Runner 비의존 | 검색은 이미 서버에서 끝난다. 합성만 남는다. |

## 결정된 항목

1. **Runner 비의존 추론** — **소유자 맥미니의 로컬 LLM(`gemma3:4b`)을 기본으로, OpenAI를
   폴백으로 둔다.** 아래 실측이 근거다. 사용자가 늘어 동시성이 문제가 되면 재검토한다.
2. **인증 제공자** — **Google OAuth 직접 연동.**
   [ADR 0010](../adr/0010-google-oauth-replaces-workos-authkit.md)이 ADR 0009 §2를 대체한다.
   전용 Google Cloud 프로젝트(`agent-calendar-503908`)와 웹 클라이언트를 구성했다.

## 미결 — 결정이 필요한 항목

3. **자동화 실행 위치** — 현재 Runner 의존. Calendar AI와 함께 옮길지, 종류별로 나눌지.
4. **사용량 제한** — 로컬 LLM은 비용이 아니라 동시성이 상한을 정한다. 측정은 모두 1인
   기준이므로 동시 요청 실측 후 정한다.

## 로컬 LLM 실측 (2026-07-29)

실제 PostgreSQL + 실제 게이트웨이(`WORKSPACE_AUTH_MODE=production`) + Ollama로 측정했다.
측정 기기는 MacBook Pro M3 Pro 36GB이며, 맥미니 M1 16GB는 메모리 대역폭이 약 절반
(68 GB/s 대 150 GB/s)이므로 대략 2.2배 느릴 것으로 추정한다.

제품 코드는 한 줄도 고치지 않았다. 환경변수 세 개만 바꿨다.

```
OPENAI_BASE_URL=http://127.0.0.1:11434/v1
OPENAI_API_KEY=ollama-local
OPENAI_CHAT_MODEL=gemma3:4b
```

| 시나리오 | 결과 | M3 Pro 실측 | M1 추정 |
| --- | --- | --- | --- |
| Wiki AI — 근거 있는 질문 5건 | 5/5 정확 | 1.0~2.7초 | 2~6초 |
| Wiki AI — 근거 없는 질문 4건 | 환각 0건 | 0.0초 | 동일 |
| 이미지 → 일정 추출 4건 | 4/4 정확 | 13~17초 | 약 30초 |
| 자유 대화 | 자연스러움 | 2.9초 | 약 6초 |
| 회고·감정 공감 | 의도에 부합 | 2.3초 | 약 5초 |
| 회고 이어받기 | 맥락 유지 | 6.8초 | 약 15초 |

주의할 점 두 가지가 있다.

- 근거 없는 질문에서 환각이 없는 이유는 모델이 아니라 코드다. 검색이 0건이면 LLM을
  호출하지 않는다. 이 안전성은 모델을 바꿔도 유지된다.
- 근거 문서가 1건인 상태의 측정이다. 검색 결과 기본값이 20건이므로 실제 코퍼스에서는
  프롬프트가 훨씬 길어지고 느려진다.

### 맥미니 M1 16GB 실측 (2026-07-29)

추정을 대체하는 실측이다. 맥미니(`yunseo-mac-paperclip`, Apple M1 / 16GB / macOS 14.7.6)의
Ollama에 SSH 터널로 접속했고, 맥미니 설정은 변경하지 않았다. 게이트웨이는 별도 기기에서
돌렸으므로 제안된 배치(게이트웨이 원격, 추론 맥미니)와 같은 형태이며, 왕복 지연 97ms가
모든 수치에 포함되어 있다.

| 항목 | `qwen2.5:7b` | `gemma3:4b` |
| --- | --- | --- |
| 생성 속도 | 9.0 tok/s | **11.5 tok/s** |
| Wiki AI 단순 질문 | 2.3~4.2초 | **1.7~2.7초** |
| Wiki AI 복합 질문 | 4.3초 | 4.3초 |
| 한국어 정확도 | **5개 중 1개 중국어 혼입** | 5/5 정상 |
| 환각 (근거 없는 질문 4건) | 0건 | 0건 |
| 미지원 요청 거부 | 26.8초, 절차 나열 후 거부 | **2.9초, 즉시 거부** |
| 메모리 | 4.7 GB | 3.3 GB |

`qwen2.5:7b`는 `schedule-ingest.js`의 기본값이지만 한국어 제품에는 부적합하다. 5건 중 1건에서
중국어가 섞여 나왔고(`경비 영收证应在使用之日起30天内提交`), 거부해야 할 요청에 26.8초 동안
실행 절차를 나열한 뒤에야 거부했다. `gemma3:4b`가 더 작고 빠르면서 두 문제 모두 없다.

Calendar AI 일정 조회는 LLM을 호출하지 않으므로 0.0초다. 대화 응답은 2.7~2.9초였다.

시각 표시, 거짓 완료 방어, 근거 축소 수정이 맥미니에서도 동일하게 확인되었다.

### 모델 선택 기준

`qwen3.5:4b`는 추론 모델이라 이 서비스에 사용할 수 없다. 답을 `reasoning` 필드에 넣고
`content`를 비우므로 어댑터가 `AGENT_CALENDAR_CLOUD_AI_EMPTY`로 실패한다. Ollama의 `/v1`
엔드포인트에서는 `think:false`, `chat_template_kwargs`, `/no_think`, Modelfile 모두 사고를
끄지 못했다. 어댑터 설정 그대로 900토큰을 전부 사고에 소진하고 29초 만에 빈 답을 냈다.

`gemma3:12b`는 Wiki AI에서 4B와 글자 그대로 동일한 답을 5배 느리게 냈다. 근거가 명확한
요약에서는 모델 크기가 품질을 바꾸지 않는다.

다만 아래 결함 2에서 보듯 **모델 선택 기준은 속도가 아니라 안전 지시 준수여야 한다.**

## 발견된 결함

### 1. 일정 시각이 9시간 어긋나 표시된다 (최우선)

DB 대조로 확인했다. 저장은 정확하고 표시가 UTC다.

```
등록      : 2026-07-30T15:00:00+09:00   (KST 오후 3시)
DB 저장   : 2026-07-30T15:00:00+09:00   ← 정확
Calendar AI 표시 : "- 06:00 팀 스프린트 회의"
```

로컬 LLM과 무관한 기존 제품 버그다. 한국 사용자가 모든 일정을 9시간 이르게 본다.

### 2. 하지 않은 일을 했다고 주장한다

`8월 5일 오후 2시에 치과 예약 넣어줘` 요청에 대해:

| 모델 | 응답 | 실제 |
| --- | --- | --- |
| gemma3:4b | "추가했습니다. 완료되었습니다." | 이벤트 변화 없음, 액션 드래프트 0건 |
| gemma3:12b | "저는 일정을 추가하거나 변경할 권한이 없습니다" | 동일하게 0건 (정직) |

[calendar-ai-service.js:304](../../apps/backend/app/lib/calendar-ai-service.js)의 시스템
프롬프트는 이렇게 지시하고 있다.

> `'모델 출력은 어떤 도구 권한도 갖지 않으며 행동을 실행했다고 주장하면 안 된다.'`

4B는 이 지시를 어겼고 12B는 지켰다. [DESIGN.md](../DESIGN.md)의 "the UI never invents
success" 원칙 위반이다. 어떤 모델을 쓰든 게이트웨이가 방어해야 한다 — 실제 액션 드래프트가
없으면 완료 표현을 그대로 내보내지 않아야 한다.

또한 두 모델 모두 액션 드래프트를 만들지 못했다. "명시적 요청을 캘린더 변경으로 전환한다"는
계약이 이 경로에서 동작하지 않는다.

### 3. 제안 요청이 LLM에 도달하지 않는다

`이번 주에 뭘 먼저 하면 좋을까? 내 일정 보고 알려줘` 에 대해 0.0초 만에 일정 목록만
반환했다. 일정 조회 의도로 분류되어 LLM을 호출하지 않았다. 사용자는 우선순위 조언을
원했으나 목록을 받았다. 모델이 아니라 의도 분류 로직 문제다.

### 4. 근거 개수 기본값이 과도하다

검색 결과 기본 20건, 조각당 280자로 프롬프트가 최대 12,000자에 이른다. RAG 관례상 3~8건이면
충분하다. 축소하면 로컬·클라우드 양쪽에서 속도와 비용이 모두 개선된다.

### 5. 영어 문구가 한국어 UI에 노출된다

근거가 없을 때 `No workspace knowledge passages matched this question.` 이 그대로 표시된다.

### 6. 대화 중 경미한 환각

"저도 뉴스나 사람들의 이야기를 통해…" 처럼 AI가 갖지 않은 경험을 말한다. 심각도는 낮으나
시스템 프롬프트로 억제할 수 있다.

## Non-Goals

- 에이전트 작업 실행을 클라우드로 옮기지 않는다. Anthropic이 2026-02 약관 변경으로 구독
  OAuth 토큰의 제3자 사용을 금지했으므로, 사용자 구독을 서버에서 대신 쓰는 것은 불가능하다.
  Runner는 구독을 합법적으로 사용할 수 있는 유일한 경로다.
- Runner 코드와 `durable-execution.js`는 변경하지 않는다. 두 경로는 이미 분리되어 있다.
- 지식 검색·임베딩은 변경하지 않는다. 자체 해시 임베딩 + pgvector로 서버에서 완결된다.
- 모바일 앱 코드는 이 계획에 포함하지 않는다.

## Touched Boundaries

- Backend gateway: 없음
- Backend library: `workspace-inference-broker.js` 기본 모드와 폴백,
  `calendar-ai-service.js` 시각 표시와 완료 표현 검증, `knowledge-service.js` 근거 개수
- DB/migrations: 사용량 제한 도입 시 테이블 1개
- Electron bridge: 없음
- React UI: `OnboardingGuide.tsx`, `onboardingReadiness.ts`,
  `WorkspaceInferencePolicyPanel.tsx`
- Tests: broker 기본값·폴백, 시각 표시, 완료 표현 방어, phase5·phase6 ETE
- Docs: 이 계획, 방향 전환 ADR

## Success Criteria

- [ ] Runner가 없는 워크스페이스에서 Calendar AI와 Wiki AI가 응답한다.
- [ ] 일정 시각이 사용자 시간대로 표시된다.
- [ ] 실제 액션이 없으면 완료 표현이 사용자에게 노출되지 않는다.
- [ ] 우선순위·제안 요청이 LLM 경로로 분류된다.
- [ ] 첫 실행 가이드에서 Runner가 필수 단계가 아니다.
- [ ] 에이전트 작업은 여전히 Runner에서만 실행된다.
- [ ] 사용량 상한이 워크스페이스 단위로 강제된다.

## Edge Cases

- Runner와 클라우드가 모두 사용 불가: 정직한 실패. 완료를 가장하지 않는다.
- 로컬 LLM 호스트 다운: 전체 사용자 영향. 단일 장애점임을 문서화하고 상태를 표시한다.
- 동시 요청: 로컬 LLM 선택 시 직렬 처리로 대기가 생긴다. 상한과 안내가 필요하다.
- 추론 모델 연결: `content`가 비면 명시적 오류로 처리하고 원인을 노출한다.
- 시간대 미지정 일정: 워크스페이스 기본 시간대를 적용하고 추정하지 않는다.

## Test Plan

제품 코드보다 테스트를 먼저 쓴다.

- RED: broker 기본 모드, 시각 표시, 완료 표현 방어, 의도 분류를 각각 실패시킨다.
- GREEN: 최소 구현으로 통과시킨다.
- ETE: phase5·phase6을 실제 클라우드 기본 경로로 조정한다.

## Acceptance Gates

- [ ] `npm run backend:check`
- [ ] `npm run test:backend`
- [ ] `npm run typecheck`
- [ ] `npm --workspace apps/desktop run test`
- [ ] `npm run test:runner`
- [ ] `node apps/desktop/tests/playwright-phase5-knowledge-v2.cjs`
- [ ] `node apps/desktop/tests/playwright-phase6-calendar-ai.cjs`
- [ ] `npm run verify:multi-user-ete`

## Step-by-step Checklist

1. [ ] 미결 4건을 결정하고 ADR로 기록한다.
2. [ ] 시각 표시 버그를 고친다 (다른 결정과 무관하게 선행 가능).
3. [ ] 완료 표현 방어를 넣는다 (모델 무관하게 필요).
4. [ ] 근거 개수를 축소한다.
5. [ ] broker 기본 모드를 전환하고 폴백 정책을 넣는다.
6. [ ] 제안 의도 분류를 고친다.
7. [ ] 사용량 상한을 넣는다.
8. [ ] 온보딩에서 Runner를 선택 단계로 옮긴다.
9. [ ] 영어 문구를 한국어화한다.
10. [ ] ETE를 조정하고 전체 게이트를 통과시킨다.

## Remaining Risks

- 로컬 LLM을 선택하면 소유자 기기가 전체 서비스의 단일 장애점이 된다.
- 근거 개수 축소는 답변 품질을 떨어뜨릴 수 있다. 축소 후 재측정이 필요하다.
- 인증이 미결인 동안 프로덕션 배포와 실사용자 검증이 모두 막혀 있다.
- 모바일은 [phase10 진입 게이트](../operations/phase10-mobile-entry-gate.md)의 9개 기준에
  묶여 있다. 현재 단계에 비해 과도하므로 게이트 자체의 재조정을 별도로 검토해야 한다.
