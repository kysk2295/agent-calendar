# Calendar AI + Wiki AI Pipeline Analysis

- Date: 2026-07-31
- Mode: read-only full analysis
- Workspace: `apps/backend`, `apps/desktop`, `docs/spec-*.md`
- Spec anchors: `docs/spec-calendar-wiki-ai.md`, `docs/spec-calendar-ai.md`, `docs/spec-wiki-ai.md`

## Executive summary

Calendar AI and Wiki AI share embeddings/LLM plumbing but keep distinct retrieval corpora and UI entry points; most honesty contracts (`answerMode`, no-retrieval threshold, contradiction retry) are implemented, while residual quality-masking and dual-path drift remain. Isolation is strong on the backend schedule-assistant path (schedule-only candidates) and golden API tests, but the primary desktop chat FAB now streams calendar-agent chat rather than pure `/api/assistant/ask`, and wiki session-turn can synthesize without forcing retrieved chunks into the model prompt. Highest leverage remaining work: ground wiki stream generation on retrieved evidence, re-align FAB routing to the contract, eliminate unlabeled post-process (`ensureCompletionAnswerCoverage`), and make live tests enforce aggregate honesty gates rather than always-LLM/always-sources.

---

## 1) Side-by-side pipeline

| Stage | Calendar AI | Wiki AI |
|---|---|---|
| **Product intent** | Personal ops assistant: schedule/task Q&A + confirmed ingest | Second-brain search: answer only from LLM-Wiki chunks |
| **UI surface** | Chat FAB (`ChatDrawer` in `apps/desktop/src/App.tsx`) | Wiki tab (`askWiki` in same file) |
| **Primary input path (current)** | `sendChat` → `POST /api/chat/stream` with `view: 'calendar'` | `askWiki` → knowledge-v2 **or** `POST /api/chat/stream` with `view: 'wiki'` |
| **Contract path (spec)** | Always `POST /api/assistant/ask` | `POST /api/wiki/search` then stream with wiki context |
| **Secondary / write path** | Attachment → `POST /api/assistant/ingest` (`schedule-ingest.js`); drafts require user confirm before `POST /calendar/events` / tasks | Read-only (no write path in wiki AI) |
| **Retrieve** | `schedule-assistant.js`: range → schedule candidates → hybrid vector search | `wiki-rag.js` / relay wiki search: markdown chunks → hybrid rank |
| **Compute** | `buildComputed` (completion-rate, work-hours, overdue, conflict, distribution) | None (no numeric aggregation) |
| **LLM** | local-llm / openai-oauth / openai; temp 0.35; contradiction → 1 retry → fallback | local-llm / oauth / openai; temp 0.2; or Hermes `wikicurator` profile via relay session turn |
| **Post-process** | `noItemsContradiction` retry; `fallbackAnswer`; **`ensureCompletionAnswerCoverage` appends missing completed titles** | `buildNoRetrievalAnswer` / `buildRetrievalOnlyAnswer` when no LLM |
| **Response meta** | `answerMode: llm \| llm-retry \| fallback`; `search.strategy: backend-calendar-ai-rag`; `search.embeddingModel` | `answerMode: llm \| no-retrieval \| retrieval-only \| retrieval-degraded \| session-turn-disabled \| …`; `retrieval.source` |
| **UI render** | Chat bubble text (+ optional draft cards for ingest/action drafts) | `.wiki-answer` + sources/meta |

### Calendar detailed flow

```
[Chat FAB text]
  → App.tsx sendChat
  → hermesApi.streamChat({ view: 'calendar', agent: 'default' })
  → gateway chat/stream calendar branch
      (phase-6 calendar AI / memory / action drafts path)
  → SSE delta/done → consoleChatStream.ts → ChatDrawer

[Chat FAB image]
  → askData → hermesApi.ingestSchedule (multipart)
  → schedule-ingest.js (OCR → structure → drafts only)
  → draft cards → user confirm → existing event/task APIs

[/api/assistant/ask — contract/golden/live path]
  → buildScheduleAssistantAnswer
      ① questionRange
      ② scheduleItemsFromState + calendarAiRecordsFromState
      ③ vectorSearch (embeddings.js)
      ④ buildComputed
      ⑤ synthesizeScheduleAnswerWithConfig
      ⑥ answerMode + sources + search meta
```

Local offline fallback: `apps/desktop/electron/scheduleAsk.ts` intercepts `/api/assistant/ask`, uses **hash embedding** + deterministic `fallbackAnswer`, always `answerMode: 'fallback'`, `strategy: 'schedule-vector'`.

### Wiki detailed flow

```
[Wiki tab question]
  → knowledgeV2 true?
      YES → hermesApi.askKnowledge (+ optional job poll)
      NO  → hermesApi.streamChat({ view: 'wiki', agent: 'wikicurator' })
            → streamRelayWikiSessionTurn (relay online):
                 parallel: wiki.search evidence + wikicurator session turn
                 evidence SSE + answer SSE; done carries sources + answerMode
            → else fallbackWikiChatStream:
                 answerWikiQuestion (wiki-rag) or relay synthesize

[/api/wiki/search]
  → relay search OR answerWikiQuestion({ synthesize: false })
  → sources + answerMode (often retrieval-only / no-retrieval)
```

Local offline fallback: `localWikiAsk.ts` + `wikiSearch.ts` — **lexical TF/IDF-ish only, no LLM**, returns `{ results }` without `answerMode` contract.

---

## 2) Shared infra and isolation guarantees

### Shared

| Component | Path | Role |
|---|---|---|
| Embeddings | `apps/backend/app/lib/embeddings.js` | Ollama `POST /api/embeddings` (default `bge-m3`); timeout 3s; **`hash-fallback` labeled** |
| Local LLM URL/model envs | used by both `schedule-assistant.js` and `wiki-rag.js` | OpenAI-compatible `/chat/completions` |
| Gateway orchestration | `apps/backend/app/railway-gateway-server.js` | ask/ingest/wiki search/stream; Railway relay to Mac mini |
| Golden fixture | `apps/backend/tests/fixtures/golden-set.json` | 15 calendar + 15 wiki |
| API golden harness | `apps/backend/tests/api-golden.test.cjs` | shared hard isolation asserts |

### Isolation guarantees that hold

1. **Screen routing:** calendar FAB vs wiki tab are separate UI entry points (`App.tsx` `sendChat` vs `askWiki`).
2. **Schedule candidate set is schedule-only:** `calendarAiRecordsFromState` and `scheduleItemsFromState` only pull tasks/events/calendarEvents/ticktick/external calendar — **not** wiki/chat/mail (`schedule-assistant.js` ~526–684). Dead helpers (`recordFromChatMessage`, `recordFromMailMessage`, `recordFromDocument`) still exist but are not wired into the candidate builder.
3. **Source type filter:** `isScheduleSource` and golden tests reject `wiki|chat|mail` on calendar responses; wiki golden rejects `task|calendar|chat|mail` in source paths.
4. **Wiki retrieval corpus:** file-based notes under wiki root / server wiki chunks — no schedule tables in `answerWikiQuestion`.
5. **Ingest confirm-before-write:** drafts only until desktop `registerScheduleDrafts` / existing APIs (matches non-goal “no silent auto-register”).

### Isolation risks / holes

| Risk | Evidence | Severity |
|---|---|---|
| **Wiki session-turn not bound to retrieved chunks** | `streamRelayWikiSessionTurn` runs search and profile chat **in parallel**; LLM messages are just the user question, not the retrieved wiki context (`railway-gateway-server.js` ~5037–5053, 3815). Hallucination risk is back even when sources look good in the evidence event. | **P0** |
| **Primary FAB path ≠ schedule RAG contract** | `sendChat` uses `/api/chat/stream` calendar agent path; `/api/assistant/ask` is used for golden/live and attachment-adjacent flows, not default text chat. Memory/action-draft surface can expand beyond pure schedule sources. | **P0** |
| **Dual local engines** | Desktop `scheduleAsk.ts` (hash) and `wikiSearch.ts` (lexical) bypass backend honesty metadata and real embeddings when proxy local routes win. | P1 |
| **Wiki index still stamps hash embeddings at chunk build** | `chunksFromWikiNotes` / `chunksFromDocument` call `createEmbedding` (hash) at index time; query path re-embeds via Ollama when available (`wiki-rag.js`). | P1 |
| **No durable embedding cache as specified** | Spec wants `record_embeddings` table + wiki mtime disk cache. Implementation uses in-memory `recordEmbeddingCache` in schedule-assistant; wiki re-embeds chunks online. | P1 |
| **Knowledge v2 fork** | Wiki tab may leave the classic wiki-rag contract entirely when `state.wiki.knowledgeV2 === true`. | P1 |

---

## 3) Truthfulness contracts

### Spec principles (both)

1. Code computes; LLM narrates.
2. Do not fake quality with post-processing; expose `answerMode`.
3. Real embeddings with honest fallback labeling.
4. No cross-pipeline contamination.
5. Route by screen, not keyword hacks.

### Calendar truthfulness status

| Contract | Status | Notes |
|---|---|---|
| `answerMode` llm / llm-retry / fallback | **Implemented** | `synthesizeScheduleAnswerWithConfig` |
| Delete `expandScheduleAnswerIfShort` | **Done** | No references in tree |
| Contradiction → regenerate once, else fallback with `llm.used: false` | **Done** | Matches M1 |
| No length hard-cut 450 | **Mostly done** | Prompt uses “120어절 이내” for some paths (still a length bias, softer) |
| `ensureCompletionAnswerCoverage` | **Violates spirit** | Silently appends missing completed titles; **does not change `answerMode`** (`schedule-assistant.js` ~897–914, applied at ~1320) |
| Sources schedule-only | **Done** on ask path | Enforced in code + golden |
| `search.embeddingModel` | **Done** | `hash-fallback` avoided on schedule when lexical path used (`lexical-fallback`) |
| FAB always ask | **Broken** | Stream chat primary |
| Ingest confirm-only | **Done** | Draft cards + register |

### Wiki truthfulness status

| Contract | Status | Notes |
|---|---|---|
| `answerMode` including `no-retrieval` | **Implemented** in `answerWikiQuestion` | Threshold default 0.35 via `AGENT_CALENDAR_WIKI_MIN_SCORE` |
| Skip LLM below threshold | **Done** in wiki-rag | Golden no-retrieval cases (김치찌개, 프로야구) |
| Cite sources in prompt | **Done** for wiki-rag synthesize path | “청크 밖 추측 금지”, “(출처: …)” |
| No length 350 hard-cut | **Done** | |
| Session-turn path honesty | **Weak** | Can emit `answerMode: 'llm'` without grounded chunks in the model context |
| Local desktop search honesty | **N/A / weak** | No answerMode; retrieval-only results list |

---

## 4) Test pyramid: coverage vs gaps

### What exists

| Layer | Calendar | Wiki | Shared |
|---|---|---|---|
| Unit | `schedule-assistant.test.cjs` (answerMode, embeddings, contradiction, computed types) | `wiki-fallback.test.cjs` (no-retrieval, stream modes, degraded) | `embeddings.test.cjs` |
| Ingest unit | `schedule-ingest.test.cjs`, `ocr-cli-contract.test.cjs` | — | |
| API golden | 15 cases via `/api/assistant/ask` | 15 cases via `/api/wiki/search` | `api-golden.test.cjs` + `golden-set.json` |
| UI wiring | `playwright-wiring.cjs` (ask + ingest mocks) | included in wiring / many wiki playwrights | |
| Live / stress | `playwright-calendar-wiki-ai-live-100.cjs`, phase6 calendar AI, chat schedule QA | wiki live scripts, graph ask | `ai-quality-matrix-live.cjs` |

### Golden-set structure

- **Total 30** = calendar **15** + wiki **15** (asserted in `api-golden.test.cjs`).
- Calendar covers questionTypes: `schedule-summary`, `completion-rate`, `overdue`, `conflict`, `distribution`, `work-hours`.
- Wiki includes **2** `expectedAnswerMode: "no-retrieval"`, **13** with `expectedFirstSourcePath`.
- Facts are **string inclusion** checks against mocked LLM / retrieval, not live DB truth.

### What golden asserts (hard)

Calendar:

- HTTP 200, `search.strategy === backend-calendar-ai-rag`, `intent === ask`
- `answerMode ∈ {llm, llm-retry, fallback}`
- `computed.questionType` match
- `mustIncludeFacts` / `mustNotInclude`
- sources not `wiki|chat|mail`

Wiki:

- `retrieval.source === expectedRetrieval` (`wiki-files`)
- `answerMode` present
- facts / forbidden
- sources not task/calendar/chat/mail
- optional exact first path or no-retrieval + `llm.used === false`

### Gaps

1. **Layer-2 aggregate gates** (100-run rates for llm ratio, hallucination, hash fallback ≤1%) are documented but **not enforced as CI gates** in `api-golden` (mocked LLM always succeeds).
2. **Primary UI path untested by golden:** chat stream calendar vs assistant ask; knowledge-v2 wiki vs wiki-rag.
3. **live-100 still assumes success shape:** calendar requires `llm.used === true` and non-empty sources; wiki requires non-empty sources and local-llm used — **conflicts with legitimate no-retrieval / empty-range honesty** (`playwright-calendar-wiki-ai-live-100.cjs` ~262–342).
4. **Wiki stream grounding** not asserted (sources present ≠ used in generation).
5. **Ingest image golden set** (`tests/fixtures/ingest-golden/`) from M5 not fully present as a measured 20-case gate in this tree review.
6. **Semantic embedding effect** partially mocked in golden fetch with hand-built vectors — good for wiring, weak for real bge-m3 regression.

---

## 5) Alignment to product intent

**Intent:** personal operations calendar + second brain, with honest grounded answers and no cross-contamination.

| Intent clause | Alignment | Comment |
|---|---|---|
| Calendar answers from real schedule DB | **Strong** on `/api/assistant/ask` | Code compute + schedule sources |
| Calendar never answers from wiki | **Strong** on ask path | Candidate set filtered |
| Wiki answers from vault only | **Medium** | wiki-rag path good; session-turn/profile path can free-talk |
| No silent schedule write | **Strong** | Ingest drafts + confirm |
| Screen-based routing | **Partial** | Screens differ, but calendar text chat is agent-stream not pure schedule RAG |
| Honest degradation | **Medium–Strong** | answerMode widely present; some silent completion append; local hash engines |
| Shared embedding quality | **Partial** | Module exists; fallbacks honest; cache/mtime incomplete; local desktop still hash/lexical |

Overall: architecture and specs match the product story; implementation is **mostly on-track for M1–M3 honesty/embeddings**, with **product-surface drift** (chat agent calendar, wiki session-turn) that can reintroduce the exact failure modes the specs were written to kill (ungrounded invention, proxy quality metrics).

---

## 6) Ranked improvement backlog

### P0 — contract integrity / hallucination risk

| # | Item | Paths | Why |
|---|---|---|---|
| P0.1 | **Ground wiki generation on retrieved chunks only** — inject top-N sources into session-turn / profile prompt; if top score &lt; minScore, force `no-retrieval` and **do not call** wikicurator | `railway-gateway-server.js` (`streamRelayWikiSessionTurn`, `runRailwayRelayWikiChat`), `wiki-rag.js` | Parallel free-form agent chat reopens “아웃소싱 에이전트”-class hallucination |
| P0.2 | **Re-align Chat FAB text path with calendar contract** — either route text Q&A to `/api/assistant/ask` (or stream that wraps the same builder) and keep agent/memory as explicit mode; document dual modes in UI | `App.tsx` (`sendChat`/`askData`), gateway calendar stream | Spec §2.5 / routing principle violated; golden tests ≠ user path |
| P0.3 | **Label or remove `ensureCompletionAnswerCoverage`** — if kept, set `answerMode: 'llm-augmented'` or similar and count as non-pure llm in quality gates | `schedule-assistant.js`, gateway relay synthesize | Silent quality masking contradicts honesty principle |
| P0.4 | **Fix live-100 hard asserts that forbid honest empty/no-retrieval outcomes** — move to layer-2 aggregate gates | `playwright-calendar-wiki-ai-live-100.cjs` | Current asserts train the system to avoid honesty |

### P1 — isolation / infra fidelity

| # | Item | Paths | Why |
|---|---|---|---|
| P1.1 | Drop or quarantine dead multi-source record builders (chat/mail/document) or hard-guard they never enter schedule RAG | `schedule-assistant.js` | Reduces future wiring mistakes |
| P1.2 | Persist schedule embeddings (`record_embeddings` or equivalent) + invalidation on update | store layer + `schedule-assistant.js` | Spec M2.4; avoids re-embed storms |
| P1.3 | Wiki index disk cache keyed by `{mtime, embeddingModel}`; stop baking hash vectors into chunk objects when Ollama available | `wiki-rag.js`, `wiki.js` | Spec W2.2–2.3 |
| P1.4 | Unify desktop local paths: either proxy to backend honesty stack or emit same `answerMode`/`retrieval` schema | `scheduleAsk.ts`, `localWikiAsk.ts`, `wikiSearch.ts` | Offline path currently lies by omission |
| P1.5 | Knowledge-v2 wiki path: same isolation + answerMode contracts as wiki-rag | knowledge service / `App.tsx` askWiki branch | Second wiki brain must not freestyle |
| P1.6 | Assert “sources used in prompt” (or citation coverage) in wiki stream tests | `wiki-fallback.test.cjs`, new contract test | Prevents evidence-only decoration |

### P2 — quality, eval, product polish

| # | Item | Paths | Why |
|---|---|---|---|
| P2.1 | Enforce layer-2 gates on real (or semi-real) runs; store baseline reports under `apps/desktop/audit/` (gitignored JSON) | live scripts, CI optional job | Spec quality system |
| P2.2 | Expand golden `mustIncludeFacts` against live workspace snapshots with `verifiedAt` | `golden-set.json` | Avoid DB drift silent fails |
| P2.3 | Semantic embedding regression with real bge-m3 (offline unit already mocked) | `embeddings.test.cjs` + smoke | Spec M2 exit gate |
| P2.4 | Soften remaining length bias in schedule prompts; prefer structure over 120-word cap | `schedule-assistant.js` `scheduleSystemPrompt` | Spec removed hard length gaming |
| P2.5 | Complete ingest image golden 10 + wiring scenario end-to-end if not measured | `schedule-ingest.js`, fixtures, `playwright-wiring.cjs` | M5 completeness |
| P2.6 | UI surfaces for `answerMode` / degraded state (user-visible honesty) | chat + wiki answer components | Users should see fallback vs grounded |

---

## Key file map

```
docs/spec-calendar-wiki-ai.md          # shared principles index
docs/spec-calendar-ai.md               # calendar contract
docs/spec-wiki-ai.md                   # wiki contract

apps/backend/app/lib/embeddings.js
apps/backend/app/lib/schedule-assistant.js
apps/backend/app/lib/schedule-ingest.js
apps/backend/app/lib/wiki-rag.js
apps/backend/app/lib/wiki.js
apps/backend/app/lib/calendar-work.js   # work draft routing (not main Q&A)
apps/backend/app/railway-gateway-server.js

apps/desktop/src/App.tsx
apps/desktop/src/features/chat/consoleChatStream.ts
apps/desktop/src/api/hermesApi.ts
apps/desktop/electron/scheduleAsk.ts
apps/desktop/electron/localWikiAsk.ts
apps/desktop/electron/wikiSearch.ts
apps/desktop/electron/wikiScanner.ts
apps/desktop/electron/localWikiGraph.ts

apps/backend/tests/fixtures/golden-set.json
apps/backend/tests/api-golden.test.cjs
apps/backend/tests/schedule-assistant.test.cjs
apps/backend/tests/wiki-fallback.test.cjs
apps/desktop/tests/playwright-wiring.cjs
apps/desktop/tests/playwright-calendar-wiki-ai-live-100.cjs
```

---

## Conclusion

The codebase has largely implemented the **honesty skeleton** the 2026-07-07 specs demanded: shared embeddings module, labeled fallbacks, `answerMode`, schedule-only candidates, wiki no-retrieval threshold, and a 30-case golden API harness with hard isolation. Remaining risk is concentrated in **product-surface dual paths** (calendar agent stream vs schedule RAG; wiki session-turn vs grounded wiki-rag) that can produce fluent answers without the retrieval contract the specs treat as non-negotiable. Closing P0.1–P0.4 restores the product contract without requiring a new architecture.
