# Wiki Ask QA Summary - 2026-07-04

## Scope

- Target path: local `/api/wiki/ask`
- Retrieval: local iCloud LLM-Wiki markdown vault
- Answer engine: Railway Hermes gateway `/api/chat/stream`
- Agent/model requested: `wiki-curator`
- Default sensitive scopes: `includeJournal=false`, `includeRaw=false`

## Test Set

- Created `tests/wiki-ask-qa-100.cjs`
- Question count: 100
- Topics:
  - UniPort
  - Market Flow Sentinel
  - Hermes OS / Mac mini runtime
  - Second brain / LLM-Wiki
  - Agents / wiki-curator
  - Automation
  - Design / UI
  - Research
  - Meta QA

## QA Checks

Each question checks:

- HTTP response succeeds
- `gatewayFallback` is not true
- engine/provider is Railway Hermes compatible
- answer length is substantial
- answer does not contain placeholder/error text
- answer does not look truncated
- at least one source is returned
- top sources roughly match the expected topic

## Runs

### Smoke Run

- Command: `WIKI_QA_LIMIT=3 WIKI_QA_CONCURRENCY=1 node tests/wiki-ask-qa-100.cjs`
- Result: 2 pass, 1 fail
- Failure: one answer was only 66 chars.
- Report files:
  - `docs/wiki-ask-qa-2026-07-04T06-45-35-751Z.json`
  - `docs/wiki-ask-qa-2026-07-04T06-45-35-751Z.md`

### Full 100-Question Attempt

- First attempt with concurrency 2 caused relay overload symptoms:
  - first two requests timed out
  - later requests fell into fallback
- Second attempt with concurrency 1 reached 11 questions before being stopped.
- Observed:
  - #1-#4 passed
  - #5-#11 failed with the same pattern
  - failure duration was consistently about 90 seconds
  - answer was not a real answer; it was relay timeout text

Example failed live response before the fix:

```json
{
  "gatewayFallback": false,
  "answer": "Railway relay failed: railway relay bridge timed out",
  "engine": {
    "provider": "railway-hermes",
    "source": "railway-relay"
  }
}
```

## Bug Found

The local Railway SSE parser treated relay timeout text as a successful answer because:

- Railway returned HTTP 200 SSE
- `gatewayFallback` in the SSE payload was false
- the final `done` text contained `Railway relay failed: railway relay bridge timed out`
- local parser did not inspect the SSE `error` field or failure text

Impact:

- UI could show a timeout as if it were a real wiki-curator answer.
- QA could falsely count relay failures as successful LLM answers.

## Fix Applied

Files:

- `electron/hermesChat.ts`
- `tests/wiki-local-ask.test.mjs`

Changes:

- Parse Railway SSE `error` field.
- Treat `Railway relay failed:` final text as an error.
- Convert Railway relay timeout into local `/api/wiki/ask` fallback response:

```json
{
  "gatewayFallback": true,
  "answer": "검색 결과 기반 임시 답변입니다. Railway Hermes 답변 생성에 실패했습니다: railway relay bridge timed out"
}
```

## Verification

Commands run:

```bash
npm run typecheck
npm test
```

Result:

- Typecheck passed.
- Test suite passed: 42/42.

Live post-fix diagnostic:

```json
{
  "elapsedMs": 90781,
  "gatewayFallback": true,
  "answer": "검색 결과 기반 임시 답변입니다. Railway Hermes 답변 생성에 실패했습니다: railway relay bridge timed out",
  "sourceCount": 8
}
```

## Conclusion

The 100-question QA process found a systemic issue before completing all 100 questions:

- Railway relay is currently timing out around 90 seconds for many wiki-curator Ask Wiki requests.
- The app previously misclassified those relay failures as successful answers.
- That misclassification is now fixed and covered by tests.

Next engineering task:

- Fix the upstream Railway relay timeout / completion handling so full 100-question QA can run meaningfully.
- After that, rerun `WIKI_QA_LIMIT=100 WIKI_QA_CONCURRENCY=1 node tests/wiki-ask-qa-100.cjs`.
