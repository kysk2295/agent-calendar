# 캘린더 AI 개발 명세서

- 작성일: 2026-07-07
- 상태: 초안 (구현 착수 기준 문서)
- 대상 코드: `apps/backend/app/lib/schedule-assistant.js`, `apps/backend/app/railway-gateway-server.js`, `apps/desktop/src/App.tsx`
- 자매 문서: [spec-wiki-ai.md](spec-wiki-ai.md) — 임베딩 인프라(§5)와 품질 검증 체계(§6)의 골격을 공유한다

---

## 1. 기획의도

**개인 비서.**

1. **읽기 (질문 모드)** — 실제 Railway DB의 일정/할일/캘린더 기록을 근거로 인용하며 내 일정에 대해 답한다. "오늘 뭐 해야 돼?", "이번 주 완료율은?", "기한 지난 할 일 뭐 있어?"
2. **쓰기 (입력 모드)** — 사진 첨부(시간표·포스터·예약 문자 캡처·손글씨)나 자연어 명령("내일 3시 회의 잡아줘")에서 일정을 추출해 **사용자 확인 후** DB에 등록한다.

**비목표 (하면 안 되는 것):**
- 위키 검색, 일반 지식 답변 — 위키 AI의 영역
- **확인 없는 자동 등록** — 잘못된 일정이 조용히 등록되는 것이 이 기능 최악의 실패 모드
- 근거 데이터: tasks, events, calendarEvents, TickTick, 외부 캘린더만. chat/mail/wiki 계열 source 금지

**판정 기준:** 답변의 모든 주장이 source에서 나왔는가(충실성), 사용자가 실제로 유용하다고 느끼는가. **답변 길이·테스트 통과율 같은 대리 지표를 목표로 삼지 않는다.**

---

## 2. 설계 원칙

1. **계산은 코드, 서술은 LLM.** 완료율·건수·시간합계·기한판정 등 결정적 값은 백엔드 코드가 계산해 구조화 컨텍스트로 전달한다. LLM은 계산하지 않는다. (현행 `buildComputed` 유지·확장)
2. **답변 후처리로 품질을 위장하지 않는다.** 짧은 답변 재확장(`expandScheduleAnswerIfShort`), 모순 답변 템플릿 교체(`repairContradictoryScheduleAnswer`)로 검증을 통과시키는 패턴을 제거/전환한다. 후처리가 개입한 응답은 메타데이터(`answerMode`)로 표시하고 품질 지표에 실패 신호로 집계한다.
3. **검색은 진짜 임베딩.** 해시 기반 유사도를 Ollama 임베딩 모델로 교체한다 (§5).
4. **위키 파이프라인과 절대 섞이지 않는다.** wiki/chat source가 응답에 포함되면 테스트 하드 실패.
5. **라우팅은 화면 기준.** 채팅 FAB의 모든 입력은 캘린더 AI로 간다. 프론트 키워드 라우팅은 삭제한다.

---

## 3. 모드 구조

캘린더 AI는 하나의 채팅 입구(FAB) 뒤에 모드 2개를 가진다.

| 모드 | 트리거 | 경로 |
|---|---|---|
| 질문 (읽기) | 텍스트만, 명령형 아님 | §3.1 Q&A 파이프라인 |
| 입력 (쓰기) | 이미지 첨부 **또는** 명령형 텍스트 | §4 일정 입력 파이프라인 |

모드 판정은 **백엔드가** 한다: 이미지가 있으면 무조건 입력 모드, 텍스트만이면 현행 `isScheduleQuestion`의 명령형 판별(잡아/등록/추가/만들어/넣어 등)로 분기하고, 판정 결과를 응답 `search.intent: "ask" | "ingest"`로 노출한다.

### 3.1 Q&A 파이프라인 (질문 모드)

```
[채팅 FAB 입력]
  → POST /api/assistant/ask            (프론트: 무조건 이 엔드포인트, 키워드 라우팅 제거)
  → ① 범위 결정   questionRange(질문, filters)         — 오늘/이번주/전체 등 날짜 범위
  → ② 후보 수집   calendarAiRecordsFromState(state)     — tasks, events, calendarEvents,
                                                          ticktickTasks, externalCalendarEvents
                                                          (chat/mail/wiki 계열은 후보에서 제외)
  → ③ 검색       임베딩 유사도 + 날짜 근접도 + 상태(미완료 가중) 하이브리드 상위 18건
  → ④ 집계       buildComputed()                        — 완료율, 건수, 근무시간, 기한초과 목록
  → ⑤ 생성       calendarassistant (OpenAI Codex GPT-5.5) — 컨텍스트 = 질문 + computed + sources
  → ⑥ 응답       { answer, sources, computed, llm, search }
```

### 3.2 검색 (schedule-assistant.js)

- `vectorSearch`의 유사도 계산을 Ollama 임베딩(§5)으로 교체.
- 최종 점수: `0.55 × 임베딩 코사인 + 0.25 × 날짜 근접도 + 0.20 × 키워드 겹침`. 미완료 항목에 ×1.15 부스트(질문이 회고성 — "완료한", "지난" 포함 — 이면 부스트 없음).
- 레코드 임베딩은 저장 시점 또는 첫 조회 시 계산해 사이드 테이블 `record_embeddings(record_id, model, vector, updated_at)`에 캐시. 제목+날짜+메모를 합친 텍스트를 임베딩 입력으로 사용.
- 반환 상한 18건 유지. source 타입 필터(`isScheduleSource`) 유지.

### 3.3 집계 (buildComputed 확장)

현행 completion-rate / work-hours / schedule-summary 3종에 추가:

| questionType | 트리거 | computed에 추가되는 필드 |
|---|---|---|
| `overdue` | 기한, 지났, 임박, 늦어 | `overdueItems[]` (제목, 기한, 경과일), `dueSoonItems[]` (48시간 이내) |
| `conflict` | 충돌, 겹치 | `conflictPairs[]` (시간대 겹치는 이벤트 쌍) |
| `distribution` | 프로젝트별, 비교, 균형 | `byTag{}` / `byList{}` 건수 집계 |

트리거 정규식은 `buildComputed` 내부에만 존재한다(라우팅에는 사용 금지). 어떤 타입에도 안 걸리면 `schedule-summary`.

### 3.4 생성

- 모델: `qwen2.5:7b` (코드 기본값과 env를 일치시킨다. 3b 오버라이드 제거). temperature 0.35 유지.
- 시스템 프롬프트 (현행 `synthesizeScheduleAnswerWithConfig` 수정):
  - 유지: "제공된 DB 기록만 근거로 답하라", "숫자는 제공된 계산값을 우선 사용", "전체가 1건 이상이면 기록이 없다고 말하지 마라"
  - **삭제: "최소 450자 이상" 등 길이 강제.** 대체: "질문에 답하는 데 필요한 만큼 충분히 쓰되, 근거 인용 → 해석 → 다음 액션 순서를 지켜라."
  - 추가: "각 판단마다 근거가 된 항목 제목을 괄호로 인용하라. 예: (근거: 유니포트 회의 7/8)"
- **`expandScheduleAnswerIfShort` 삭제.** 짧은 답변은 늘리는 게 아니라 품질 지표(§6)로 집계한다.
- **`repairContradictoryScheduleAnswer` 전환:** 모순 감지(`noItemsContradiction`) 시 1회에 한해 "sources가 N건 존재한다. 없다고 말하지 말고 다시 답하라"를 덧붙여 **재생성**한다. 재생성도 모순이면 그때 결정적 fallback(`fallbackAnswer`)으로 대체하되 `llm.used: false`, `answerMode: "fallback"`으로 정직하게 표기한다.

### 3.5 응답 스키마

```jsonc
{
  "ok": true,
  "answer": "…",
  "answerMode": "llm" | "llm-retry" | "fallback",   // 신규. 후처리 개입 여부를 숨기지 않는다
  "sources": [ { "id", "title", "date", "time", "sourceType", "done", "score" } ],
  "computed": { "range", "total", "done", "undone", "completionRate", "questionType", … },
  "llm": { "provider": "local-llm", "model": "qwen2.5:7b", "used": true },
  "search": { "strategy": "backend-calendar-ai-rag", "intent": "ask", "embeddingModel": "…", "candidateCount", "sourceCount" }
}
```

---

## 4. 일정 입력 (쓰기 모드) — 신규 개발

사진이나 명령형 텍스트에서 일정을 추출해 등록하는 경로. **핵심 원칙: AI는 초안만 만들고, DB 쓰기는 사용자 확인 후에만 일어난다.**

```
[채팅 FAB: 이미지 첨부 또는 "내일 3시 회의 잡아줘"]
  → POST /api/assistant/ingest         (신규. multipart: image? + text?)
  → ① 텍스트화   이미지가 있으면 OCR/비전 (§4.2), 텍스트면 그대로
  → ② 구조화     로컬 LLM이 일정 후보 배열로 추출 (§4.3)
  → ③ 검증       코드 레벨: 날짜 파싱 가능 여부, 과거 날짜 경고, 기존 일정과 시간 충돌 검사
  → ④ 초안 응답  { drafts: [...], conflicts: [...] } — 아직 DB에 아무것도 쓰지 않음
[프론트: 초안 카드 렌더 → 사용자가 항목별 수정/선택 → "등록" 클릭]
  → 기존 POST /calendar/events, POST /tasks 재사용 (신규 쓰기 엔드포인트 만들지 않음)
  → 등록 결과를 채팅에 확인 메시지로 표시
```

### 4.1 왜 확인 단계가 필수인가

OCR·소형 LLM의 날짜 인식 오류(7월 8일↔8월 7일, 오전↔오후)는 발생 전제로 설계한다. 잘못된 일정이 조용히 등록되는 것이 최악의 실패 모드이므로, 확인 없는 자동 등록은 **금지 사항**이다(§1 비목표).

### 4.2 이미지 → 텍스트

- **1순위: Apple Vision 프레임워크 OCR** (Mac mini 로컬). 한국어 인쇄체·손글씨 인식이 소형 비전 LLM보다 정확하고 빠르다. 작은 Swift CLI 헬퍼(`apps/backend/tools/ocr-cli`)로 감싸 `child_process`로 호출. 결과: 텍스트 블록 + 좌표.
- **2순위(폴백): Ollama 비전 모델** `qwen2.5vl:7b`. OCR 결과가 빈약하거나(글자 수 < 10) 이미지가 표/포스터처럼 레이아웃 해석이 필요할 때 사용.
- 어떤 경로를 탔는지 응답 `ingest.ocrEngine: "apple-vision" | "qwen-vl" | "none"`으로 표기.

### 4.3 텍스트 → 일정 초안 (구조화)

- 모델: qwen2.5:7b, temperature 0.1 (추출 작업이므로 낮게), JSON 강제 출력.
- 프롬프트에 반드시 포함: 오늘 날짜와 요일(상대 날짜 "내일/다음 주 화요일" 해석용), "이미지/텍스트에 없는 일정을 만들어내지 마라", "불확실한 필드는 null로 두라".
- 출력 스키마 (코드에서 검증, 검증 실패 시 1회 재생성):

```jsonc
{
  "drafts": [
    {
      "kind": "event" | "task",
      "title": "유니포트 회의",
      "date": "2026-07-08",          // ISO, 필수. 파싱 불가면 항목 제외하고 warnings에 기록
      "start": "15:00" | null,
      "end": "16:00" | null,
      "location": null,
      "notes": "원문: '내일 3시 회의'", // 추출 근거 원문 스니펫 필수
      "confidence": "high" | "low"     // low는 프론트에서 노란 배지로 표시
    }
  ],
  "warnings": ["'8일 저녁'은 시간이 불명확해 시작 시간을 비웠습니다"],
  "conflicts": [ { "draftIndex": 0, "existing": { "id", "title", "date", "time" } } ]
}
```

### 4.4 프론트 (App.tsx)

- 채팅 입력창에 이미지 첨부 버튼 추가 (1장, 10MB 제한, jpg/png/heic).
- 초안 응답을 채팅 말풍선 안에 **편집 가능한 카드 목록**으로 렌더: 제목/날짜/시간 인라인 수정, 항목별 체크박스, 충돌 항목엔 기존 일정 표시. 하단에 [선택 항목 등록] / [취소].
- 등록 성공 시 "N건 등록했어요" + 등록된 항목 요약을 채팅에 남긴다 (Q&A 모드가 바로 이어서 참조 가능해야 함).

---

## 5. 임베딩 인프라 (위키 AI와 공유)

- **모델:** Mac mini Ollama에 `bge-m3` (1순위, 한국어 강함) 또는 `nomic-embed-text` (2순위, 경량). `POST {OLLAMA}/api/embeddings`.
- **모듈:** `apps/backend/app/lib/embeddings.js` 신규.
  - `embedText(text, { model, fetchImpl })` → `number[]`
  - `embedBatch(texts)` — 인덱싱용
  - Ollama 미응답 시 현행 해시 벡터로 **폴백**하되 응답 `search.embeddingModel: "hash-fallback"`으로 표기. 폴백률은 품질 지표로 집계.
- 임베딩 1회당 예산 ~50ms. 질문 임베딩 1회 + 캐시된 후보 벡터 비교이므로 전체 지연 영향은 미미해야 한다.

---

## 6. 품질 검증 체계

### 6.1 두 계층 분리

**계층 1 — 하드 어서션 (결정적, 1건이라도 실패 시 즉시 실패):**

- HTTP 200, `/api/assistant/ask`·`/api/assistant/ingest` 호출 건수 정확, 위키 스트림 호출 0건
- `search.strategy === "backend-calendar-ai-rag"`, `llm.provider === "local-llm"` (폴백 제외 실행 시)
- sources는 전부 task/calendar 계열 — chat/wiki 오염 금지
- 응답 스키마 유효성 (`answerMode`, `search.intent` 존재)
- **입력 모드**: drafts의 date가 전부 유효한 ISO인가, **confirm 전에 DB에 레코드가 생기지 않았는가**(ingest 직후 DB 카운트 불변 확인), notes에 근거 원문이 있는가, **원문에 없는 환각 일정 0건** (1건이라도 하드 실패)

**계층 2 — 품질 게이트 (확률적, 개별 실패는 기록만, 런 전체 집계로 판정):**

| 지표 | 기준 (100회 런) |
|---|---|
| `answerMode === "llm"` 비율 | ≥ 95% |
| 모순 감지율 (1차 생성 기준) | ≤ 5% |
| 답변 공백제거 길이 ≥ 200자 | ≥ 90% (450자 하드컷 폐지) |
| 한국어 외 문자 혼입 (중국어 등) | ≤ 2% |
| 임베딩 해시 폴백률 | ≤ 1% |
| 골든셋 사실 포함률 (§6.2) | ≥ 90% |
| 입력 골든셋: 날짜 정확도 | ≥ 95% |
| 입력 골든셋: 제목 유사 일치 | ≥ 90% |

기준 미달 시 런 실패. **개별 질문의 LLM 출력에 대한 `assert`는 두지 않는다** — 장시간 런이 답변 하나로 죽는 구조 금지.

### 6.2 골든셋

- 위치: `apps/backend/tests/fixtures/golden-set.json` (Q&A), `apps/backend/tests/fixtures/ingest-golden/` (입력)
- 문항의 목표 품질 기준과 골든셋 변환 예시는 **부록 A** 참조.
- **Q&A 15문항**: DB에 실재하는 기대 사실 명시.

```jsonc
{
  "kind": "calendar",
  "question": "오늘 일정 요약해줘",
  "mustIncludeFacts": ["병원"],
  "mustNotInclude": ["기록이 없"],
  "expectedSourceTypes": ["calendar-event", "task"],
  "expectedComputed": { "questionType": "schedule-summary" }
}
```

- **입력 20건**: 픽스처 이미지 10장(시간표 2, 포스터 2, 예약문자 캡처 2, 카톡 캡처 2, 손글씨 2) + 명령형 텍스트 10문장. 각각 기대 추출값(제목·날짜·시간) 명시.
- DB 내용 변경 시 골든셋도 갱신한다(소유자: 본인). 사실 포함 검사는 문자열 포함으로 시작하고, 필요해지면 강한 모델(LLM-judge)로 충실성 채점을 추가한다.

### 6.3 테스트 피라미드

| 레벨 | 파일 | 실행 시점 | 내용 |
|---|---|---|---|
| 유닛 | `schedule-assistant.test.cjs` (현행 확장) | 매 커밋 | buildComputed 타입별 계산, 점수식, 모순 감지, 폴백 표기, ingest 스키마 검증 |
| API 통합 | `tests/api-golden.test.cjs` (신규) | 매 커밋 (LLM 필요 시 로컬) | 골든셋을 Playwright 없이 fetch 직접 호출, 계층 1+2 검증. 목표 3분 내 |
| UI 배선 | `playwright-wiring.cjs` (신규, 소형) | 매 커밋 | Q&A 3문항 + "이미지 첨부 → 초안 카드 → 등록 → 캘린더 표시" 1시나리오 |
| 라이브 리그레션 | `playwright-calendar-wiki-ai-live-100.cjs` (현행 수정) | 야간 1회 + 프롬프트/모델 변경 시 | 계층 2 집계 게이트로 전환, 개별 assert 제거 |

- `apps/desktop/audit/*.json` 실행 산출물은 `.gitignore`에 추가. 요약 md 리포트만 커밋.

---

## 7. 상세 개발 로드맵

총 소요: 약 5~6 작업일. 의존 관계: `M1 → M2 → M3 → M4 → M5` (단, M5 Phase 1은 M4와 병행 가능).

```
M1 정직성 ──→ M2 임베딩 ──→ M3 평가 체계 ──→ M4 품질 상향 ──→ M5-P2 프론트 카드 ──→ M5-P3 이미지
   (0.5d)      (1d, 위키공동)   (1d, 위키공동)      (0.5d) ─┬─────────↑
                                                  M5-P1 텍스트 명령 (병행 가능, 1d)
```

**공통 규칙:** 각 마일스톤 종료 시 골든셋 통과율·게이트 지표를 `apps/desktop/audit/`의 md 리포트로 기록한다. **측정 없이 다음 마일스톤으로 넘어가지 않는다.** 모든 작업은 유닛 테스트와 같은 커밋으로 들어간다.

### M1 — 정직성 확보 (0.5일)

목적: 이후 모든 측정의 기준선을 오염 없이 만든다. 후처리 패치가 남아 있으면 M2~M4의 개선 효과를 측정할 수 없다.

| # | 작업 | 대상 | 완료 기준 (DoD) |
|---|---|---|---|
| 1.1 | 응답에 `answerMode` 필드 도입 (`"llm" \| "llm-retry" \| "fallback"`) | `schedule-assistant.js` `buildScheduleAssistantAnswer`, 게이트웨이 pass-through | 모든 `/api/assistant/ask` 응답에 필드 존재. 유닛 테스트로 3가지 값 각각 검증 |
| 1.2 | `expandScheduleAnswerIfShort` 함수 삭제 + 시스템 프롬프트에서 "최소 450자" 등 길이 강제 문구 제거, "근거 인용→해석→다음 액션" 구조 문구로 대체 | `schedule-assistant.js:763`, `synthesizeScheduleAnswerWithConfig` | 함수·호출부 제거, 프롬프트에 길이 숫자 없음 |
| 1.3 | 모순 처리 전환: `noItemsContradiction` 감지 시 템플릿 교체(`repairContradictoryScheduleAnswer`) 대신 "sources N건 존재, 없다고 말하지 말라"를 덧붙여 **재생성 1회**(`answerMode: "llm-retry"`) → 재실패 시 `fallbackAnswer` + `answerMode: "fallback"`, `llm.used: false` | `schedule-assistant.js:534~561` | 유닛: 모의 LLM으로 재생성 성공/실패 두 경로 검증. 템플릿이 `llm.used: true`로 나가는 경로 소멸 |
| 1.4 | live-100 테스트에서 450자·모순 개별 assert 제거 → 결과에 기록만. `answerMode` 분포를 리포트에 추가 | `playwright-calendar-wiki-ai-live-100.cjs` | 개별 LLM 출력 assert 0개 (계층 1 어서션은 유지) |
| 1.5 | `apps/desktop/audit/*.json` gitignore 추가, 기존 15개 커밋 대상에서 제외 | `.gitignore` | `git status`에 audit JSON 안 뜸 |

**종료 게이트:** 유닛 전체 통과 + live-100 1회 실행 → `answerMode: "llm"` 비율, 모순율, 길이 분포를 **기준선(baseline)으로 기록**.

### M2 — 진짜 임베딩 (1일, 위키 AI와 공동)

| # | 작업 | 대상 | 완료 기준 (DoD) |
|---|---|---|---|
| 2.1 | Mac mini Ollama에 `bge-m3` 설치, `POST /api/embeddings` 스모크 (한국어 문장 2개 유사도 sanity check: "회의 일정"↔"미팅 약속" > "회의 일정"↔"김치찌개") | 인프라 | curl로 벡터 반환 확인, 유사도 순서 정상 |
| 2.2 | `embeddings.js` 신규: `embedText`, `embedBatch`, 타임아웃 3s, Ollama 실패 시 해시 벡터 폴백 + `"hash-fallback"` 표기 | `apps/backend/app/lib/embeddings.js` (신규) | 유닛: 정상 경로·타임아웃 폴백·표기 검증 (mock fetch) |
| 2.3 | `vectorSearch` 교체: 점수식 `0.55×임베딩 + 0.25×날짜근접 + 0.20×키워드`, 미완료 ×1.15 부스트(회고성 질문 제외) | `schedule-assistant.js:171` | 유닛: 날짜 근접·부스트 로직 결정적 검증 (임베딩은 mock) |
| 2.4 | 레코드 임베딩 캐시: `record_embeddings(record_id, model, vector, updated_at)`, 최초 조회 시 batch 계산, 레코드 갱신 시 무효화 | 게이트웨이 store 계층 | 동일 질문 2회째 호출에서 임베딩 API 호출 0건 (로그 확인) |
| 2.5 | `/api/assistant/ask` 응답 `search.embeddingModel` 추가 | 게이트웨이 | 응답 필드 존재 |

**종료 게이트:** 부록 A.1~A.3 유형 질문 3개를 수동 실행해 sources 상위 5건이 질문과 관련 있는지 확인. 질문 임베딩 1회 ≤ 100ms 실측. 해시 폴백률 0% 확인.

### M3 — 평가 체계 (1일, 위키 AI와 공동)

| # | 작업 | 대상 | 완료 기준 (DoD) |
|---|---|---|---|
| 3.1 | Q&A 골든셋 15문항 작성 — 부록 A를 원형으로, **실제 DB를 조회해** `mustIncludeFacts`를 실재 값으로 채움. 구성: completion-rate 2, overdue 2, 일반 요약 4, 특정 프로젝트(유니포트) 3, 데이터 없음(fallback 기대) 2, 회고성 2 | `tests/fixtures/golden-set.json` | 15문항 전부 기대값이 현재 DB에서 검증됨 |
| 3.2 | `api-golden.test.cjs` 신규: Playwright 없이 fetch로 직접 호출, 계층 1 하드 어서션 + 계층 2 집계 게이트(§6.1 표 기준) | `apps/backend/tests/api-golden.test.cjs` (신규) | 로컬 LLM 살아있는 환경에서 3분 내 완주, 게이트 판정 출력 |
| 3.3 | `playwright-wiring.cjs` 신규: Q&A 3문항 배선만 검증 (FAB→ask 호출→렌더). LLM 품질 검사 없음 | `apps/desktop/tests/playwright-wiring.cjs` (신규) | 2분 내 완주 |
| 3.4 | live-100 개편: 계층 2 집계 게이트로 최종 판정, 리포트에 게이트 지표 표 포함, 실패해도 100회 완주 후 판정 | `playwright-calendar-wiki-ai-live-100.cjs` | 중간 1건 실패로 런이 죽지 않음 |

**종료 게이트:** 골든셋 baseline 점수 기록. **이 점수가 이후 모든 변경의 비교 기준이 된다.**

### M4 — 품질 상향 (0.5일 + 측정)

| # | 작업 | 대상 | 완료 기준 (DoD) |
|---|---|---|---|
| 4.1 | Calendar 전용 Hermes 프로필을 OpenAI Codex GPT-5.5로 고정하고 골든셋 전후 비교 + p95 지연 측정 | Mac mini Hermes profile | 자연어 품질 게이트 통과, 첫 응답 p90 ≤ 30s. 실패 시 typed failure와 근거 기반 fallback 유지 |
| 4.2 | `buildComputed`에 overdue/conflict/distribution 타입 + computed 필드 (§3.3 표) | `schedule-assistant.js:491` | 유닛: 타입별 결정적 계산 검증 (기한 경과일, 시간대 겹침, 태그별 집계) |
| 4.3 | 프론트 키워드 라우팅 삭제 — 채팅 FAB 입력 전부 `/api/assistant/ask` | `App.tsx` | wiring 테스트: 키워드 없는 일정 질문도 ask 호출 |
| 4.4 | 프롬프트에 근거 인용 형식 "(근거: 항목명 날짜)" 적용 | `schedule-assistant.js` | 골든셋 재측정에서 근거 인용 포함률 ≥ 80% |

**종료 게이트:** 골든셋 사실 포함률 ≥ 90%, `answerMode: "llm"` ≥ 95%, p95 ≤ 6s.

### M5 — 일정 입력 (쓰기 모드, 2~3일)

**Phase 1 — 텍스트 명령 (1일, M4와 병행 가능)**

| # | 작업 | 대상 | 완료 기준 (DoD) |
|---|---|---|---|
| 5.1 | `/api/assistant/ingest` 신규 + 모드 분기: 이미지 존재 → ingest, 명령형 텍스트(`isScheduleQuestion` 명령 판별 재활용) → ingest, 그 외 → ask. 응답 `search.intent` | 게이트웨이, `schedule-assistant.js` | 유닛: 분기 3경로. **ingest 응답 시점 DB 카운트 불변** |
| 5.2 | 구조화 추출: qwen2.5:7b, temp 0.1, JSON 강제, §4.3 스키마. 오늘 날짜·요일 주입(상대 날짜 해석). 코드 검증 실패 시 재생성 1회 | `apps/backend/app/lib/schedule-ingest.js` (신규) | 유닛: 스키마 검증기 단독 테스트. "내일 3시 회의" → ISO 날짜 정확 |
| 5.3 | 충돌 검사: draft 시간대와 기존 events 겹침 → `conflicts[]` | `schedule-ingest.js` | 유닛: 겹침/비겹침/시간없음 3케이스 |
| 5.4 | 입력 골든셋 텍스트 10문장 작성·측정 (상대 날짜 5, 절대 날짜 3, 모호 2) | `tests/fixtures/ingest-golden/` | 날짜 정확도 ≥ 95%, 환각 draft 0건 |

**Phase 2 — 프론트 초안 카드 (0.5~1일)**

| # | 작업 | 대상 | 완료 기준 (DoD) |
|---|---|---|---|
| 5.5 | 초안 카드 UI: 인라인 수정, 체크박스, confidence:low 노란 배지, 충돌 표시, [등록]/[취소] | `App.tsx` | 부록 A.4 형태 렌더 |
| 5.6 | 등록 연결: 선택 항목을 기존 `POST /calendar/events`·`POST /tasks`로, 성공 시 확인 메시지 채팅 잔류 | `App.tsx` | 등록 후 캘린더 뷰에 즉시 반영 |
| 5.7 | Playwright 시나리오: 명령 입력 → 카드 → 등록 → 캘린더 표시 + **취소 시 DB 불변** | `playwright-wiring.cjs` | 시나리오 통과 |

**Phase 3 — 이미지 입력 (1일)**

| # | 작업 | 대상 | 완료 기준 (DoD) |
|---|---|---|---|
| 5.8 | Apple Vision OCR 헬퍼: Swift CLI(`ocr-cli <image>` → JSON 텍스트 블록), Node에서 child_process 호출 | `apps/backend/tools/ocr-cli` (신규) | 한국어 예약 문자 캡처에서 날짜·시간 문자열 정확 추출 |
| 5.9 | 이미지 첨부 UI + multipart 업로드 (1장, 10MB, jpg/png/heic) | `App.tsx`, 게이트웨이 | 첨부 → ingest → 카드 렌더 |
| 5.10 | `qwen2.5vl:7b` 폴백 (OCR 글자 수 < 10 또는 표/포스터), `ingest.ocrEngine` 표기 | `schedule-ingest.js` | 유닛: 폴백 분기. 응답에 engine 표기 |
| 5.11 | 이미지 골든셋 10장(시간표2·포스터2·예약문자2·카톡2·손글씨2) 측정 | `tests/fixtures/ingest-golden/` | 날짜 ≥ 95%, 제목 유사 ≥ 90%, 환각 0건 |

**종료 게이트:** §6.1 입력 모드 하드 어서션 전체 통과 + 입력 골든셋 20건 기준 충족.

### 리스크와 대응

| 리스크 | 신호 | 대응 |
|---|---|---|
| bge-m3 지연 초과 | 임베딩 1회 > 100ms | `nomic-embed-text`로 교체 (모듈 인터페이스 동일) |
| 7b 메모리/지연 부족 | p95 > 6s 또는 OOM | q4 양자화 → 그래도 안 되면 3b 유지 + 골든셋 점수로 손익 기록 |
| Apple Vision 헬퍼 빌드 실패 | Swift 툴체인 문제 | Phase 3 순서 뒤집어 qwen2.5vl 단독으로 먼저 출시, OCR은 후속 |
| 골든셋이 DB 변경으로 깨짐 | 기대 사실 불일치 | 골든셋에 `verifiedAt` 날짜 기록, 실패 시 DB 먼저 확인하는 절차 명시 |

---

## 8. 성능 목표

| 항목 | 목표 (p95) | 현재 실측 (2026-07-07 리포트) |
|---|---|---|
| Q&A 응답 | ≤ 6s | avg 2.5s / max 3.5s (3b 기준 — 7b 전환 후 재측정) |
| 질문 임베딩 1회 | ≤ 100ms | 미측정 |
| 입력: 텍스트 명령 → 초안 | ≤ 5s | 미개발 |
| 입력: 이미지 → 초안 (OCR 경로) | ≤ 10s | 미개발 |
| 입력: 이미지 → 초안 (비전 LLM 폴백) | ≤ 25s | 미개발 |

7b 전환으로 지연이 목표를 넘으면 num_predict 상한과 sources 수(18→12)로 조정하고, 그래도 넘으면 3b/7b 중 골든셋 점수-지연 트레이드오프를 측정해 결정한다.

---

## 부록 A — 질문·답변 예시 (목표 품질 기준)

아래 예시가 이 명세서가 목표하는 답변 품질의 기준이며, 골든셋(§6.2)의 원형이다. "현재"는 2026-07-07 라이브 100회 리포트 실측이다. 날짜는 오늘 = 2026-07-07(화) 가정.

### A.1 질문 모드 — 숫자 질문 (completion-rate)

**Q: "이번 주 완료율을 알려줘"**

❌ **현재 (3b + 검색 실패, sources 0건):**

> 이 정보로는 이번 주의 완료율을 한 문장으로 정확히 알려드릴 수 없습니다. 추가로 이번 주에 수행한 일정과 작업의 요약이 필요합니다.

✅ **목표** — 완료율은 `buildComputed`가 코드로 계산해 전달, LLM은 해석과 액션만:

> 이번 주(7/6~7/12) 완료율은 **58.3%**입니다. 전체 12건 중 7건이 완료됐고 5건이 남아 있어요.
>
> 남은 5건을 보면 흐름이 보입니다. 유니포트 쪽 작업이 3건(근거: 유니포트 회의 준비 7/8, 카드뉴스 초안 7/9, MVP 피드백 정리 7/10)으로 몰려 있고, 개인 일정이 2건(근거: 병원 예약 7/9, 서류 제출 7/11)입니다. 완료된 7건이 대부분 주 초반 마감이었던 걸 보면 지금 속도 자체는 나쁘지 않지만, 수요일 회의 전에 끝나야 하는 "회의 준비"가 아직 미완료라는 게 가장 급한 지점이에요.
>
> **다음 액션:** 오늘 중 "유니포트 회의 준비"를 먼저 처리하세요. 병원 예약(7/9 14:00)과 카드뉴스 초안 마감이 같은 날이라 목요일이 병목이 될 가능성이 높습니다.

- 메타데이터: `answerMode: "llm"`, `computed: { total: 12, done: 7, completionRate: 58.3, questionType: "completion-rate" }`, sources 전부 task/calendar 계열
- 골든셋 변환: `mustIncludeFacts: ["58.3", "12건", "7건"]`, `mustNotInclude: ["알려드릴 수 없"]`

### A.2 질문 모드 — 기한 질문 (overdue, M4 추가 타입)

**Q: "기한 지났거나 임박한 할 일 정리해줘"**

✅ **목표** — `overdueItems[]`/`dueSoonItems[]`를 코드가 판정:

> 기한이 지난 항목이 2건, 48시간 안에 마감인 항목이 3건 있습니다.
>
> **이미 지난 것:** ① 세금계산서 발행 (기한 7/4, **3일 경과**) ② 위키 문서 백업 설정 (기한 7/6, 1일 경과). 세금계산서는 경과일이 가장 길고 외부 상대가 있는 일이라 오늘 최우선입니다.
>
> **임박한 것:** ③ 유니포트 회의 준비 (7/8 오전) ④ 병원 예약 (7/9 14:00 — 할 일이 아니라 시간 약속이니 놓치면 복구 불가) ⑤ 카드뉴스 초안 (7/9).
>
> **다음 액션:** 오늘 세금계산서 → 회의 준비 순서로 처리하고, 위키 백업은 회의 뒤로 미뤄도 리스크가 낮습니다 (근거: 5건 모두 미완료 상태, DB 기한 필드 기준).

### A.3 질문 모드 — 데이터가 정말 없을 때 (정직한 fallback)

**Q: "다음 달 제주도 일정 어떻게 돼?"**

✅ **목표** — 검색 결과 0건이면 지어내지 않고 `answerMode: "fallback"`:

> 8월 범위에서 '제주도'와 관련된 일정이나 할 일을 찾지 못했어요. 아직 등록을 안 하셨다면 "8월 14일 제주도 여행 잡아줘"처럼 말씀해주시면 바로 등록해드릴게요.

- 규칙: sources 0건일 때 "없다"는 답은 정상(모순 아님). sources가 있는데 "없다"고 하면 §3.4의 재생성 대상.

### A.4 입력 모드 — 자연어 명령

**Q: "다음 주 화요일 3시에 유니포트 투자자 미팅 잡아줘"**

✅ `/api/assistant/ingest`가 초안만 반환 → 채팅에 편집 가능한 카드:

> 📋 **일정 초안 1건** — 확인 후 등록됩니다
>
> | | |
> |---|---|
> | 제목 | 유니포트 투자자 미팅 |
> | 날짜 | 2026-07-14 (화) |
> | 시간 | 15:00 |
> | 근거 | 원문: "다음 주 화요일 3시에 유니포트 투자자 미팅" |
> | ⚠️ 충돌 | 같은 날 14:30~15:30 「팀 주간회의」와 겹칩니다 |
>
> [✏️ 수정] [✅ 등록] [취소]

- 사용자가 [등록]을 눌러야 `POST /calendar/events` 실행. 등록 후 채팅: "7/14(화) 15:00 유니포트 투자자 미팅을 등록했어요. 팀 주간회의와 겹치니 하나를 옮기는 걸 추천해요."
- 검증 포인트: 상대 날짜("다음 주 화요일") 해석 정확성, 충돌 감지, ingest 시점 DB 불변

### A.5 입력 모드 — 사진 첨부 (예약 문자 캡처)

**📷 이미지** (문자 내용: "[OO정형외과] 김세오님 7/21(화) 오전 10:30 예약되었습니다")

✅ Apple Vision OCR → LLM 구조화 → 초안 카드:

> 📋 사진에서 일정 1건을 찾았어요 (인식: apple-vision)
>
> | | |
> |---|---|
> | 제목 | OO정형외과 예약 |
> | 날짜 | 2026-07-21 (화) |
> | 시간 | **10:30** 🟡 확인 필요 — 원문의 "오전"을 반영했어요 |
> | 근거 | 원문: "7/21(화) 오전 10:30 예약되었습니다" |
>
> [✏️ 수정] [✅ 등록] [취소]

- 날짜·시간이 조금이라도 애매하면 `confidence: "low"` → 노란 배지. **조용히 틀리게 등록되는 일이 절대 없게** 하는 것이 §4.1의 핵심.
- 입력 골든셋 변환: 기대 추출값 `{ title: "OO정형외과 예약", date: "2026-07-21", start: "10:30" }`, 환각 draft 0건.
