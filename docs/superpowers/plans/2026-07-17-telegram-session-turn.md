# Telegram Session Turn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Desktop Wiki AI run one hidden turn in the currently active Telegram `wikicurator` session, stream the unchanged curator answer to Desktop, and attach vector-search wiki evidence without sending the Desktop turn to Telegram.

**Architecture:** Hermes Gateway owns the session-turn contract because it alone has the active Telegram session key, transcript, model override, cached agent, and busy state. A capture sink replaces Telegram delivery for Desktop-originated turns while preserving the same runner and transcript. The Mac mini Relay bridge forwards Hermes turn events, Railway starts the turn and vector search in parallel, and the existing Desktop SSE consumer progressively renders deltas and evidence.

**API role decision:** The Hermes Dashboard API on `:9121` remains the control plane for session discovery, health, and observability. It has no chat execution route. The existing Gateway API on `:8642` is the execution plane; the new capture endpoint is a thin adapter to its already-bound live `GatewayRunner`, not a separate AI service. The generic `/api/sessions/{id}/chat/stream` route remains unchanged because it runs the API Server agent rather than the live Telegram cached agent.

**Tech Stack:** Python 3.11 asyncio/FastAPI Hermes Gateway, Node.js CommonJS Relay bridge and Railway backend, React 18/TypeScript Desktop renderer, Node test runner, pytest, Playwright, SSE.

**Status:** Ready for implementation.

---

## Source Specification

- `docs/superpowers/specs/2026-07-16-telegram-session-turn-design.md`

## Work Size And Boundaries

- Large / Boundary change.
- Hermes Gateway source: `/Users/koyunseo/.hermes/hermes-agent/gateway/**` and `/Users/koyunseo/.hermes/hermes-agent/tests/gateway/**`.
- Mac mini Relay runtime: `/Users/goyunseo/.hermes/os-runtime/scripts/hermes-railway-relay-bridge.js` and `/Users/goyunseo/.hermes/os-runtime/tests/railway-relay-profile-chat.test.js`.
- Backend gateway: `apps/backend/app/railway-gateway-server.js` and `apps/backend/app/lib/**`.
- Backend tests: `apps/backend/tests/**`.
- Desktop contract/UI verification: `apps/desktop/src/**` and `apps/desktop/tests/**`.
- No database migration or persisted public API schema change.

## Non-Goals

- Do not send Desktop questions or answers through Telegram Bot API or a user MTProto session.
- Do not inject vector-search snippets into the curator question or system prompt.
- Do not create a new Hermes mission, subprocess, session, or model override.
- Do not change Calendar AI, Work Conversation, or other Responsible Agent routes.
- Do not remove the old `profile.chat` implementation until the separate 20-turn performance gate passes.

## Contract To Implement

Railway enqueues this private Relay job. The bridge must reject any other profile, source, delivery mode, or policy.

```js
{
  kind: 'session.turn',
  payload: {
    profile: 'wikicurator',
    source: 'telegram',
    message: 'UniPort BM 요약',
    requestId: 'wiki-turn-01',
    delivery: 'capture',
    policy: 'wiki-read-only',
  },
}
```

The Relay event stream is append-only and terminates exactly once:

```js
{ type: 'accepted', requestId, provider, model, sessionVersion, queued: false }
{ type: 'delta', requestId, sequence: 1, text: '현재 BM은 ' }
{ type: 'tool-status', requestId, label: '위키 확인 중' } // optional and sanitized
{ type: 'completed', requestId, text, provider, model, sessionVersion }
{ type: 'failed', requestId, code, retryable }
```

Raw Telegram chat IDs, Hermes session IDs, prompts, tokens, tool arguments, and private paths must never enter these events.

## File Map

### Hermes files to create

- `/Users/koyunseo/.hermes/hermes-agent/gateway/session_turn.py`: event types, in-memory idempotency/TTL registry, one-item busy queue, capture sink, stable errors.
- `/Users/koyunseo/.hermes/hermes-agent/tests/gateway/test_session_turn.py`: session selection, transcript, capture-only delivery, model pinning, queue, replay, timeout, and safety tests.
- `/Users/koyunseo/.hermes/hermes-agent/tests/gateway/test_api_server_session_turn.py`: authenticated local SSE endpoint tests.

### Hermes files to modify

- `/Users/koyunseo/.hermes/hermes-agent/gateway/run.py`: expose `GatewayRunner.run_session_turn`, route the turn through the existing Telegram session and cached agent, and accept an optional capture sink in the normal execution path.
- `/Users/koyunseo/.hermes/hermes-agent/gateway/platforms/api_server.py`: add the authenticated local `/api/gateway/session-turns/stream` endpoint that delegates to the bound Gateway runner.

### Mac mini runtime files to modify

- `/Users/goyunseo/.hermes/os-runtime/scripts/hermes-railway-relay-bridge.js`: handle `session.turn`, call the local Hermes SSE endpoint, and append each event to Railway immediately.
- `/Users/goyunseo/.hermes/os-runtime/tests/railway-relay-profile-chat.test.js`: add exact payload, event ordering, retry, sanitization, and terminal-event tests.

### Agent Calendar files to create

- `apps/backend/app/lib/relay-session-turn.js`: enqueue and follow one `session.turn` Relay job as an async event stream.
- `apps/backend/tests/relay-session-turn.test.cjs`: Relay cursor, replay, timeout, abort, and terminal behavior tests.
- `apps/desktop/tests/playwright-wiki-session-turn-stream.cjs`: progressive answer plus independent evidence UI contract.

### Agent Calendar files to modify

- `apps/backend/app/railway-gateway-server.js`: feature-gated parallel `session.turn` and `wiki.search` orchestration and immediate SSE forwarding.
- `apps/backend/tests/wiki-fallback.test.cjs`: exact unchanged question, parallel start, multi-delta, evidence, and stable failure assertions.
- `apps/backend/package.json`: include the new backend module in the syntax gate if the check script uses an explicit list.
- `apps/desktop/package.json`: register the new focused Playwright command only if tests are enumerated explicitly.
- `docs/superpowers/plans/2026-07-17-telegram-session-turn.md`: record verification evidence and remaining risk as tasks complete.

## Success Criteria

- [ ] A Desktop wiki question is written exactly once into the active Telegram `wikicurator` transcript.
- [ ] The turn uses the active Telegram provider/model override and existing cached agent.
- [ ] No Desktop question, answer, typing indicator, progress message, or tool result is sent to Telegram.
- [ ] The unchanged curator answer reaches Desktop as multiple SSE deltas as soon as Hermes emits them.
- [ ] `wiki.search` starts without waiting for the curator and appears only as clickable evidence tags.
- [ ] A disconnect/retry with the same request ID does not duplicate provider execution or transcript entries.
- [ ] Side-effect tools are unavailable under `wiki-read-only`.
- [ ] All terminal paths produce exactly one `completed` or stable `failed` event.
- [ ] Live first-token time is under 30 seconds in two consecutive acceptance runs.

## Task 1: Pure Hermes Session-Turn Registry And Capture Contract

**Files:**
- Create: `/Users/koyunseo/.hermes/hermes-agent/gateway/session_turn.py`
- Create: `/Users/koyunseo/.hermes/hermes-agent/tests/gateway/test_session_turn.py`

- [ ] **Step 1: Write failing registry and sink tests**

Cover exact request replay, conflicting message detection, ten-minute result expiry, one queued request, terminal-event uniqueness, and ordered delta capture:

```python
@pytest.mark.asyncio
async def test_same_request_replays_one_execution():
    clock = FakeClock()
    registry = SessionTurnRegistry(clock=clock, ttl_seconds=600, max_queued=1)
    calls = 0

    async def execute(sink):
        nonlocal calls
        calls += 1
        await sink.delta("첫 ")
        await sink.delta("답변")
        return SessionTurnResult(text="첫 답변", provider="openai-codex", model="gpt-5.5", session_version="opaque-v1")

    first = await collect(registry.stream(request_id="req-1", message="질문", execute=execute))
    replay = await collect(registry.stream(request_id="req-1", message="질문", execute=execute))

    assert calls == 1
    assert replay == first
    assert [event.type for event in first] == ["accepted", "delta", "delta", "completed"]

@pytest.mark.asyncio
async def test_same_request_with_different_message_fails():
    events = await collect(registry.stream(request_id="req-1", message="다른 질문", execute=execute))
    assert events[-1].code == "idempotency_conflict"
```

- [ ] **Step 2: Run the narrow test and confirm RED**

Run:

```bash
cd /Users/koyunseo/.hermes/hermes-agent
python -m pytest tests/gateway/test_session_turn.py -q
```

Expected: FAIL because `gateway.session_turn` does not exist.

- [ ] **Step 3: Implement the minimal pure module**

Use frozen event/result dataclasses and an `asyncio.Condition`-backed registry. The public API is `SessionTurnRegistry(clock=time.monotonic, ttl_seconds=600, max_queued=1)`, `SessionTurnRegistry.stream(request_id, message, execute)`, `SessionTurnSink.accepted(provider, model, session_version, queued)`, `SessionTurnSink.delta(text)`, and `SessionTurnSink.tool_status(label)`.

The registry owns replay buffers, execution tasks, request/message hashes, sequence numbers, terminal de-duplication, queue depth, and TTL cleanup. Store neither question text nor answer text in logs.

- [ ] **Step 4: Run the test and confirm GREEN**

Run the same pytest command. Expected: all registry/sink tests pass.

- [ ] **Step 5: Commit the pure contract**

```bash
git -C /Users/koyunseo/.hermes/hermes-agent add gateway/session_turn.py tests/gateway/test_session_turn.py
git -C /Users/koyunseo/.hermes/hermes-agent commit -m "feat: add gateway session turn contract"
```

## Task 2: Route Capture Turns Through The Live Telegram Gateway Runner

**Files:**
- Modify: `/Users/koyunseo/.hermes/hermes-agent/gateway/run.py`
- Modify: `/Users/koyunseo/.hermes/hermes-agent/tests/gateway/test_session_turn.py`

- [ ] **Step 1: Write failing runner tests**

Build a runner fixture with one active Telegram DM session, a `gpt-5.5` model override, a cached fake agent, and a Telegram adapter spy. Assert:

```python
events = await collect(runner.run_session_turn(
    source_platform="telegram",
    message="UniPort BM 요약",
    request_id="req-live-1",
    policy="wiki-read-only",
))

assert fake_agent.calls[0].history == existing_history
assert fake_agent.calls[0].model == "gpt-5.5"
assert telegram_adapter.sent == []
assert transcript[-2:] == [user_turn("UniPort BM 요약"), assistant_turn("자연어 답변")]
assert public_metadata(events).isdisjoint({"chat_id", "session_id", "prompt", "tool_args"})
```

Also assert `curator_session_unavailable`, session/model pinning after acceptance, exact-once transcript persistence, a single queued turn, `curator_busy`, and 90-second timeout.

- [ ] **Step 2: Run the focused test and confirm RED**

```bash
cd /Users/koyunseo/.hermes/hermes-agent
python -m pytest tests/gateway/test_session_turn.py -q
```

Expected: FAIL because `GatewayRunner.run_session_turn` and capture routing do not exist.

- [ ] **Step 3: Implement runner integration with the smallest signature change**

Add keyword-only `session_turn_sink: SessionTurnSink | None = None` and `policy: str | None = None` parameters to `_handle_message_with_agent` and `_run_agent`. Existing callers must keep their current behavior through the `None` defaults.

`run_session_turn` must:

1. validate `source_platform == "telegram"` and `policy == "wiki-read-only"`;
2. resolve the most recently active Telegram DM session inside the current profile;
3. atomically pin its session key, session ID, run generation, and model runtime;
4. call the existing `_handle_message_with_agent` path with a synthetic inbound event and capture sink;
5. keep existing transcript persistence and cached-agent reuse;
6. skip Telegram typing, progress, stream consumer, final response, and tool-result delivery whenever a capture sink is present.

For the read-only policy, build the agent tool list from the normal Telegram toolsets and filter out tools whose canonical action class is any of:

```python
WIKI_SESSION_TURN_FORBIDDEN_ACTIONS = {
    "external_message", "publish", "purchase", "trade",
    "delete", "write", "settings", "schedule", "shell",
}
```

If Hermes tools do not expose action classes, deny by registered tool name using one centralized immutable allowlist containing only wiki/search/read/history tools. Never infer safety from prompt text alone.

- [ ] **Step 4: Run focused and adjacent Gateway tests**

```bash
cd /Users/koyunseo/.hermes/hermes-agent
python -m pytest tests/gateway/test_session_turn.py -q
python -m pytest tests/gateway -q
```

Expected: capture tests pass; existing Telegram Gateway behavior remains green.

- [ ] **Step 5: Commit runner integration**

```bash
git -C /Users/koyunseo/.hermes/hermes-agent add gateway/run.py tests/gateway/test_session_turn.py
git -C /Users/koyunseo/.hermes/hermes-agent commit -m "feat: run captured turns in telegram sessions"
```

## Task 3: Expose An Authenticated Local Hermes SSE Endpoint

**Files:**
- Modify: `/Users/koyunseo/.hermes/hermes-agent/gateway/platforms/api_server.py`
- Create: `/Users/koyunseo/.hermes/hermes-agent/tests/gateway/test_api_server_session_turn.py`

- [ ] **Step 1: Write failing endpoint tests**

Test 401 without the existing API key, 422 for any unsupported profile/source/delivery/policy, exact delegation to the bound runner, incremental SSE, disconnect-safe execution, and no secret metadata.

```python
response = client.stream("POST", "/api/gateway/session-turns/stream", headers=auth, json={
    "profile": "wikicurator",
    "source": "telegram",
    "message": "질문 원문",
    "requestId": "req-api-1",
    "delivery": "capture",
    "policy": "wiki-read-only",
})

assert next_sse(response)["type"] == "accepted"
assert next_sse(response) == {"type": "delta", "requestId": "req-api-1", "sequence": 1, "text": "첫 토큰"}
```

- [ ] **Step 2: Confirm RED**

```bash
cd /Users/koyunseo/.hermes/hermes-agent
python -m pytest tests/gateway/test_api_server_session_turn.py -q
```

- [ ] **Step 3: Implement the local-only endpoint**

Resolve the runner from the already-bound Gateway message handler; do not construct a second `AIAgent`:

```python
runner = getattr(self._message_handler, "__self__", None)
if runner is None or not hasattr(runner, "run_session_turn"):
    raise HTTPException(status_code=503, detail="curator_session_unavailable")

return StreamingResponse(
    encode_sse(runner.run_session_turn(
        source_platform=payload.source,
        message=payload.message,
        request_id=payload.requestId,
        policy=payload.policy,
    )),
    media_type="text/event-stream",
    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
)
```

Bind only to the existing local API Server interface and reuse its bearer-key authentication.

- [ ] **Step 4: Run endpoint and Gateway suites**

```bash
cd /Users/koyunseo/.hermes/hermes-agent
python -m pytest tests/gateway/test_api_server_session_turn.py tests/gateway/test_session_turn.py -q
python -m pytest tests/gateway -q
```

- [ ] **Step 5: Commit the endpoint**

```bash
git -C /Users/koyunseo/.hermes/hermes-agent add gateway/platforms/api_server.py tests/gateway/test_api_server_session_turn.py
git -C /Users/koyunseo/.hermes/hermes-agent commit -m "feat: expose local gateway session turn stream"
```

## Task 4: Stream Session Turns Through The Mac Mini Relay Bridge

**Files:**
- Modify on Mac mini: `/Users/goyunseo/.hermes/os-runtime/scripts/hermes-railway-relay-bridge.js`
- Modify on Mac mini: `/Users/goyunseo/.hermes/os-runtime/tests/railway-relay-profile-chat.test.js`

- [ ] **Step 1: Write failing bridge tests**

Use a fake local Hermes SSE server and fake Railway callback server. Assert exact request body, headers, event order, immediate delta forwarding before local completion, stable error mapping, retry replay, and that raw error bodies are not forwarded.

```js
assert.deepEqual(localHermes.requests[0].body, {
  profile: 'wikicurator',
  source: 'telegram',
  message: '질문 원문',
  requestId: 'req-relay-1',
  delivery: 'capture',
  policy: 'wiki-read-only',
});
assert.deepEqual(railway.events.map((event) => event.type), [
  'accepted', 'delta', 'delta', 'completed',
]);
assert.ok(railway.events[1].receivedAt < localHermes.completedAt);
```

- [ ] **Step 2: Run the Mac mini focused test and confirm RED**

```bash
cd /Users/goyunseo/.hermes/os-runtime
node --test tests/railway-relay-profile-chat.test.js
```

- [ ] **Step 3: Implement `session.turn` handling**

The handler validates the fixed contract, POSTs to `/api/gateway/session-turns/stream`, parses SSE frames across arbitrary chunk boundaries, and calls the existing Relay append-event API for every decoded event without waiting for process exit. It must not log `message`, response text, authorization, or chat/session identifiers.

- [ ] **Step 4: Run the runtime suite and restart the bridge only after GREEN**

```bash
cd /Users/goyunseo/.hermes/os-runtime
node --test tests/railway-relay-profile-chat.test.js
npm test
launchctl kickstart -k gui/$(id -u)/com.yunseo.hermes-railway-relay
```

- [ ] **Step 5: Verify the bridge health projection**

Confirm one poller, no crash loop, and `session.turn` capability without printing credentials or session IDs.

## Task 5: Add The Railway Relay Session-Turn Consumer

**Files:**
- Create: `apps/backend/app/lib/relay-session-turn.js`
- Create: `apps/backend/tests/relay-session-turn.test.cjs`
- Modify: `apps/backend/package.json` if needed

- [ ] **Step 1: Write failing Relay consumer tests**

```js
test('forwards ordered session turn events before the terminal event', async () => {
  const received = [];
  const result = await runRelaySessionTurn({
    relay,
    payload: exactPayload,
    timeoutMs: 90_000,
    onEvent: (event) => received.push(event),
  });

  assert.deepEqual(received.map((event) => event.type), ['accepted', 'delta', 'delta', 'completed']);
  assert.equal(result.text, '자연어 답변');
  assert.equal(relay.jobs[0].kind, 'session.turn');
});
```

Also test cursor continuation, duplicate event suppression, unknown event rejection, one terminal event, `curator_busy`, `relay_disconnected`, abort, and 90-second timeout.

- [ ] **Step 2: Confirm RED**

```bash
node --test apps/backend/tests/relay-session-turn.test.cjs
```

- [ ] **Step 3: Implement `runRelaySessionTurn`**

```js
async function runRelaySessionTurn({ relay, payload, timeoutMs = 90_000, signal, onEvent = () => {} }) {
  const job = relay.enqueue({ kind: 'session.turn', payload });
  let cursor = 0;
  while (true) {
    const batch = await relay.waitForEvents(job.id, { cursor, timeoutMs, signal });
    for (const event of batch.events) {
      cursor = Math.max(cursor, event.sequence);
      validatePublicSessionTurnEvent(event.payload);
      await onEvent(event.payload);
      if (event.payload.type === 'completed') return event.payload;
      if (event.payload.type === 'failed') throw toStableSessionTurnError(event.payload);
    }
  }
}
```

Adapt the exact `waitForEvents` call to the existing `HermesRailwayRelay` API; preserve cursor semantics from `relay-profile-completion.js` rather than inventing a second polling contract.

- [ ] **Step 4: Run focused tests and backend syntax gate**

```bash
node --test apps/backend/tests/relay-session-turn.test.cjs
npm run backend:check
```

- [ ] **Step 5: Commit the backend consumer**

```bash
git add apps/backend/app/lib/relay-session-turn.js apps/backend/tests/relay-session-turn.test.cjs apps/backend/package.json
git commit -m "feat: consume relay session turn streams"
```

## Task 6: Run Curator And Evidence In Parallel In Railway

**Files:**
- Modify: `apps/backend/app/railway-gateway-server.js`
- Modify: `apps/backend/tests/wiki-fallback.test.cjs`

- [ ] **Step 1: Write failing orchestration tests**

Add a deferred fake Relay test proving both jobs exist before either resolves:

```js
assert.deepEqual(relay.jobs.map((job) => job.kind).sort(), ['session.turn', 'wiki.search']);
assert.equal(relay.jobs.find((job) => job.kind === 'session.turn').payload.message, question);
assert.equal(relay.jobs.find((job) => job.kind === 'session.turn').payload.retrieval, undefined);
```

Append `accepted`, two `delta`, and `completed` session events before completing search. Read the response stream incrementally and assert the first two answer chunks arrive while search is still pending. Then finish search and assert one `evidence` event contains de-duplicated source references and `done` is last.

Add tests for:

- feature flag off returns concise unavailable text plus evidence, without calling old `profile.chat`;
- session failure keeps any partial answer and independently attaches evidence;
- evidence failure does not discard the natural-language answer;
- raw search snippets are never emitted as assistant deltas;
- one request ID is reused across reconnects;
- actual provider/model remain diagnostics while `responsibleAgent === 'wiki-curator'`.

- [ ] **Step 2: Run focused test and confirm RED**

```bash
node --test apps/backend/tests/wiki-fallback.test.cjs
```

- [ ] **Step 3: Implement immediate SSE orchestration**

At the beginning of `fallbackWikiChatStream`, write SSE headers immediately, then start both promises before awaiting either:

```js
const evidencePromise = runRailwayRelayWikiSearch({ question, limit });
const turnPromise = runRelaySessionTurn({
  relay,
  payload: {
    profile: 'wikicurator',
    source: 'telegram',
    message: question,
    requestId,
    delivery: 'capture',
    policy: 'wiki-read-only',
  },
  timeoutMs: 90_000,
  onEvent: (event) => forwardSessionTurnEvent(res, event),
});

const [turn, evidence] = await Promise.allSettled([turnPromise, evidencePromise]);
writeEvidenceOrFailure(res, evidence);
writeSseEvent(res, 'done', buildTerminalPayload(turn, evidence));
res.end();
```

Use `HERMES_WIKI_SESSION_TURN_ENABLED` as the only rollout switch. Do not call `runRailwayRelayWikiChat` automatically on any session-turn failure.

- [ ] **Step 4: Run focused and full backend gates**

```bash
node --test apps/backend/tests/wiki-fallback.test.cjs apps/backend/tests/relay-session-turn.test.cjs
npm run backend:check
npm run test:backend
```

- [ ] **Step 5: Commit Railway orchestration**

```bash
git add apps/backend/app/railway-gateway-server.js apps/backend/tests/wiki-fallback.test.cjs
git commit -m "feat: stream curator session turns with wiki evidence"
```

## Task 7: Lock The Desktop Progressive Rendering Contract

**Files:**
- Create: `apps/desktop/tests/playwright-wiki-session-turn-stream.cjs`
- Modify: `apps/desktop/src/App.tsx` only if the failing test reveals a real gap
- Modify: `apps/desktop/package.json` only if test scripts are enumerated

- [ ] **Step 1: Write the failing Playwright contract**

Stub `/api/chat/stream` with delayed frames:

```text
event: accepted\ndata: {"provider":"openai-codex","model":"gpt-5.5"}
event: delta\ndata: {"text":"현재 UniPort는 "}
event: delta\ndata: {"text":"CPA와 B2B 데이터 BM을 함께 봐야 합니다."}
event: evidence\ndata: {"sources":[{"id":"wiki-1","title":"UniPort BM 정본"}]}
event: done\ndata: {"responsibleAgent":"wiki-curator"}
```

Assert the first partial text is visible before the second frame is released, the final answer is exact concatenation, one source button appears after evidence, clicking it opens the matching wiki document, and no raw event/provider/session metadata appears in the answer bubble.

- [ ] **Step 2: Run the focused UI test and observe RED or existing GREEN**

```bash
npm --workspace apps/desktop run build
node apps/desktop/tests/playwright-wiki-session-turn-stream.cjs
```

If it is already green, make no renderer product-code change. A test-only commit is correct because the existing consumer already appends multiple `delta` events and accepts sources from independent events.

- [ ] **Step 3: Make only the minimal renderer fix if required**

The consumer must append each `delta.text`, merge de-duplicated `evidence.sources`, keep partial text on `failed`, and stop the indicator on `done`. It must not expose provider/model as the Responsible Agent label.

- [ ] **Step 4: Run Desktop gates**

```bash
npm run typecheck
npm --workspace apps/desktop run test
npm run build:desktop
node apps/desktop/tests/playwright-wiki-session-turn-stream.cjs
```

- [ ] **Step 5: Commit the Desktop contract**

```bash
git add apps/desktop/tests/playwright-wiki-session-turn-stream.cjs apps/desktop/src/App.tsx apps/desktop/package.json
git commit -m "test: cover progressive curator session answers"
```

## Task 8: Deploy Behind The Flag And Run Live Acceptance

**Files:**
- Update: `docs/superpowers/plans/2026-07-17-telegram-session-turn.md`

- [ ] **Step 1: Deploy Hermes Gateway and Relay bridge on Mac mini**

Apply the committed Hermes source to the active `/Users/goyunseo/.hermes/hermes-agent`, run focused tests there, restart only the Hermes Gateway and Relay LaunchAgents, and verify a single healthy instance of each.

- [ ] **Step 2: Deploy Railway with the flag initially disabled**

Deploy the tested backend, confirm health, then set:

```text
HERMES_WIKI_SESSION_TURN_ENABLED=1
```

Do not change any Telegram token, webhook, polling owner, provider, model, or session identifier.

- [ ] **Step 3: Run the first live acceptance turn**

Use a nonce-bearing question in the packaged Desktop app. Record only timing and opaque request metadata. Verify:

- accepted within 1 second;
- first natural-language token within 30 seconds;
- final display within 2 seconds of provider completion;
- completion model is the active Telegram OpenAI model;
- evidence button opens the expected wiki document;
- Telegram contains no new Desktop question, answer, typing, or progress message.

- [ ] **Step 4: Verify shared context and exact-once behavior**

Ask a Telegram follow-up that depends on the hidden Desktop nonce and confirm the curator continues the context. Reconnect/replay the same Desktop request ID and confirm there is no second provider run or duplicate transcript turn.

- [ ] **Step 5: Run a second consecutive live acceptance turn**

Repeat with a new nonce. Both runs must meet the same correctness gates. If either fails, disable the flag and retain concise failure plus evidence behavior.

- [ ] **Step 6: Record verification notes without secrets**

Update this plan with commands, pass/fail counts, first-token timings, and any skipped gate reason. Do not record chat IDs, session IDs, API keys, message contents containing private data, or provider tokens.

## Task 9: Final Review, Merge, And Push

**Files:**
- Review all files listed above
- Update: `docs/superpowers/plans/2026-07-17-telegram-session-turn.md`

- [ ] **Step 1: Run repository-wide gates**

```bash
npm run backend:check
npm run test:backend
npm run typecheck
npm --workspace apps/desktop run test
npm run build:desktop
npm test
```

- [ ] **Step 2: Review the diff for scope and secrets**

```bash
git status --short
git diff --check
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Confirm no token, owner chat ID, raw session ID, prompt dump, local private path, or unrelated user file entered the commits.

- [ ] **Step 3: Mark this plan Verified and commit verification notes**

```bash
git add docs/superpowers/plans/2026-07-17-telegram-session-turn.md
git commit -m "docs: verify telegram session turn rollout"
```

- [ ] **Step 4: Merge the implementation to `main` and push**

Use a non-destructive fast-forward or normal merge, verify `origin/main` contains every implementation commit, and push the Hermes source repository separately if it has a configured authorized remote. Never overwrite unrelated changes.

## Acceptance Gates

- [ ] Hermes focused session-turn tests
- [ ] Hermes full Gateway tests
- [ ] Mac mini Relay runtime tests
- [ ] `npm run backend:check`
- [ ] `npm run test:backend`
- [ ] `npm run typecheck`
- [ ] `npm --workspace apps/desktop run test`
- [ ] `npm run build:desktop`
- [ ] focused Desktop Playwright stream test
- [ ] `npm test`
- [ ] two consecutive live Desktop turns under 30 seconds to first token
- [ ] no Telegram UI delivery
- [ ] Telegram follow-up observes Desktop context
- [ ] exact-once reconnect/replay

## Rollback

1. Set `HERMES_WIKI_SESSION_TURN_ENABLED=0` in Railway.
2. Keep `profile.chat` code available but do not automatically route failed turns to it.
3. Leave vector evidence available with a concise “큐레이터 세션에 연결할 수 없습니다” message.
4. Restart only the Railway backend if the environment platform requires it; Hermes and Relay code can remain dormant.
5. Re-enable only after focused Mac mini, Railway, and Desktop acceptance gates pass again.

## Verification Notes

- Not run yet. Populate during Tasks 1–9.

## Remaining Risks

- The active Mac mini Hermes tree may differ from the local Hermes source; compare commits and patch context before deployment.
- Hermes upstream updates may overwrite the capture seam; keep the Hermes changes committed in its source repository and document the deployed commit.
- The shared transcript intentionally contains Desktop-only turns that are invisible in Telegram UI; future UI may need a session-activity marker.
- Provider latency or rate limits can still exceed 30 seconds. Timing must distinguish provider first-token latency from Relay and Desktop delivery latency.
- The old `profile.chat` path remains until a separate 20-turn p95 gate passes; this plan does not delete it.
