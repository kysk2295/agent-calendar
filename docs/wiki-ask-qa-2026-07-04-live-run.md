# Wiki Ask Live QA Run

- Date: 2026-07-04
- Target: local Ask Wiki retrieval + Railway Hermes `/api/chat/stream`
- Agent: `wiki-curator`
- Vault: `/Users/koyunseo/Library/Mobile Documents/com~apple~CloudDocs/LLM-Wiki`
- Mode: real calls only, no mock answers

## What Was Tested

I added a regression test for the largest observed failure mode: giant markdown chunks being sent wholesale to Hermes. Before the fix, a single huge runtime log made the Railway prompt 57,219 characters. After context compaction, the same path/heading/snippet metadata is preserved while the prompt stays under 12,000 characters.

Then I started live QA against the actual Railway endpoint with the 100-question harness. I used a sequential smoke run first because the relay had already shown 90-second timeout behavior under concurrency.

## Live Results Observed

- Planned questions: 100
- Smoke attempted before stopping: 5 of 10
- Client-observed pass: 2
- Client-observed fail: 3
- Main failure: `railway relay bridge timed out` around 90 seconds
- Additional quality issue: one Railway-stored answer was visibly truncated

I stopped the run after the same timeout pattern repeated three times. Continuing to 100 at that point would mostly measure the relay outage/bridge completion problem, not Ask Wiki answer quality.

## Actual Answers Recovered From Railway History

### 1. UniPort에서 지금 제일 중요한 병목은?

> UniPort에서 지금 제일 중요한 병목은 **유저 0명 상태를 어떻게 깨고 시장 검증 증거를 만들 것인가**야.
>
> [2]에서 명확히 현재 중요한 질문으로 이걸 꼽고 있고, [7]에서도 출시 직후에 "사용자 확보(마케팅)와 핵심 차별 루프(그룹모의투자 재미)의 검증/수정이 동시에 필요하다"고 운영 지침으로 나와 있어. 실행하지 않는 사람을 운영상 어떻게 제한할지도 함께 언급되는데, 결국 초기 traction이 안 생기면 그 뒤의 모든 운영/개발이 의미가 없어지는 구조야.
>
> 다른 소스들은 감정 관리, Discord 봇 포맷, 주간 리포트, Hermes 기술 이슈 정도라 UniPort 병목 자체를 직접적으로 더 구체화하진 않아. 위키 근거로는 이게 제일 앞에 있는 병목이야.

QA note: 자연스러운 답변이고 citation도 사용함. 답변 품질은 통과.

### 2. UniPort 로드맵에서 당장 실행해야 할 3가지는 뭐야?

> 제공된 sources에 UniPort-로드맵.md의 실제 내용(마일스톤, 우선순위, 이번 주 할 일 등)이 포함되어 있지 않아서, "당장 실행해야 할 3가지"를 구체적으로 확인할 수 없어.
>
> 위키 근거 부족.

QA note: 모르는 내용을 지어내지 않았으므로 정책상 통과. 다만 검색이 실제 로드맵 chunk를 못 가져오면 제품 관점에서는 검색 품질 개선 대상.

### 3. UniPort 시스템 구조를 비개발자에게 설명해줘

> UniPort 시스템은 **투자 교육 콘텐츠를 30일 과정으로 제공하는 앱**이에요. 비개발자 관점에서 보면, 크게 세 가지가 맞물려 돌아가는 구조예요.
>
> ### 1. 콘텐츠 만드는 흐름 (가장 핵심)
> - 교육 콘텐츠(카드, Day별 자료)를 **디스코드**에서 직접 만들고 수정해요.
> - 수정하면 바로 **미리보기**로 확인할 수 있어요.
> - 확인 후 **앱에 반영** (배포)하면 실제 앱 사용자들이 볼 수 있게 돼요.
>
> 이 과정이 디스코드 봇을 통해 자동으로 연결되어 있어요. 개발자가 아니어도 디스코드만 쓰면 콘텐츠를 관리할 수 있게 설계된 거죠.
>
> ### 2. 앱 본체
> - 실제로 사용자들이 쓰는 모바일 앱이에요.
> - 교육 콘텐츠가 앱 안에 어떻게 보이고, 어떻게 렌더링되는지는 별도 구조로 관리돼요.
> - 현재는 Android 기반 모노레포(하나의 저장소)로 개발 중이에요.
>
> ### 3. 마케팅·운영 자동화
> - 인스타그램에 교육 관련 콘텐츠를 자동으로 올리는 시스템이 있어요.
> - 디스코드 봇이 교육 콘텐츠와 관련된 명령어를 처리하고

QA note: 내용은 자연스럽지만 마지막 문장이 끊겨 있음. 실패.

### 4. UniPort 팀 협업 구조의 리스크는 뭐야?

> UniPort 팀 협업 구조

QA note: 너무 짧고 질문에 답하지 않음. 실패.

### 5. UniPort 교육 렌더 구조에서 앱과 프리뷰는 어떻게 연결돼?

> Railway relay failed: railway relay bridge timed out

QA note: 실패. 앱에서는 fallback으로 보여야 하는 응답.

## Diagnostics

- Railway simple smoke, `READY만 답해`: failed to complete within 45 seconds. SSE reached `Bridge job queued`, but no Mac mini completion event arrived.
- Local Hermes API, `http://127.0.0.1:8642/v1/models`: connection refused.
- Local Hermes API, `/chat/completions`: connection refused.
- Current process list did not show a local Hermes API server on port 8642.

## QA Verdict

Ask Wiki retrieval and request construction are now testable and compacted, but full 100-question live QA is blocked by Hermes/Railway runtime availability:

- The app is making real Railway calls.
- The answers are not mock data.
- The local context payload is no longer oversized.
- The current blocker is the Mac mini bridge/local Hermes runtime not consistently returning completion events to Railway.

## Follow-up Required Before Full 100-Question Run

1. Start or restore the local Hermes API server on `127.0.0.1:8642`.
2. Confirm the Railway relay bridge can complete `READY만 답해` within 45 seconds.
3. Rerun:

```bash
WIKI_QA_LIMIT=100 WIKI_QA_CONCURRENCY=1 WIKI_QA_TIMEOUT_MS=240000 node tests/wiki-ask-qa-100.cjs
```

