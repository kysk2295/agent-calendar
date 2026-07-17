# Mac mini Direct Wiki Curator and Calendar Runtime

## Runtime boundary

- Dashboard API `127.0.0.1:9121` is the control/read plane for sessions,
  profiles, scheduler jobs, and health. It does not execute curator turns.
- Curator Gateway API `127.0.0.1:8643` owns the persisted `wikicurator`
  Agent API session and serves `/api/sessions/{id}/chat/stream` directly. The
  desktop session is versioned as `agent-calendar-wiki-v2`.
- Calendar Gateway API `127.0.0.1:8644` owns the persisted
  `calendarassistant` session. It has no toolsets and uses
  `openai-codex` / `gpt-5.5` only for grounded natural-language synthesis.
- Ollama `127.0.0.1:11434` owns Wiki and Calendar evidence embeddings
  (`bge-m3`). It is not the Calendar natural-language generation provider.
- Railway enqueues `agent.chat` with either `wiki.search` or
  `calendar.search`. Curator answers are returned unchanged; Calendar exact
  existence answers are checked against deterministic date/title/time facts
  before any buffered text is exposed.
- Telegram sessions, Telegram delivery, and Telegram-selected routes do not
  participate in the desktop Wiki AI request path.

## Deployed artifacts

- Relay bridge:
  `/Users/goyunseo/.hermes/os-runtime/scripts/hermes-railway-relay-bridge.js`
- Relay tests:
  `/Users/goyunseo/.hermes/os-runtime/tests/railway-relay-profile-chat.test.js`
- Curator Gateway runtime:
  `/Users/goyunseo/.hermes/hermes-agent/gateway/platforms/api_server.py`
- Curator profile config:
  `/Users/goyunseo/.hermes/profiles/wikicurator/config.yaml`
- Curator profile instructions:
  `/Users/goyunseo/.hermes/profiles/wikicurator/SOUL.md`
- Calendar profile config:
  `/Users/goyunseo/.hermes/profiles/calendarassistant/config.yaml`
- Wiki vector index:
  `/Users/goyunseo/.hermes/cache/agent-calendar-wiki-vectors.json`
- Calendar vector index:
  `/Users/goyunseo/.hermes/cache/agent-calendar-schedule-vectors.json`
- LaunchAgents:
  `com.yunseo.hermes-railway-relay`, `ai.hermes.gateway-wikicurator`,
  `ai.hermes.gateway-calendarassistant`

The Relay directory is not a git checkout. Deployment-time backups are kept
next to the runtime files with timestamped `.bak-*` or `.backup-*` suffixes.
The existing Hermes Agent API is reused; no Telegram-capture fork is required
for desktop Wiki AI execution.

## Behavioral contracts

- Backend sends only `profile`, the unchanged user `message`, `requestId`, and
  a stable desktop `conversationId`; retrieval chunks are never inserted into
  the Agent request.
- Relay ensures the persisted API session exists, then calls
  `/api/sessions/{conversationId}/chat/stream` with the unchanged user message.
- New API sessions use a title suffixed with their `conversationId`, so a safe
  session rotation cannot fail because an older session owns the same title.
- The API request uses a separate read-only Q&A system instruction: do not load
  skills, do not mutate files, inspect only relevant wiki files, answer in
  natural Korean with at least one complete sentence, and say what was checked
  when evidence is insufficient. One-word or fragment-only answers are invalid.
- Relay has a reserved `agent.chat` lane and three general job lanes.
- Curator deltas are coalesced before Railway callbacks; a stalled
  non-terminal callback cannot block the terminal event.
- Known provider/rate-limit/authentication messages are typed failures and are
  never promoted to `answerMode: llm`.
- The `wikicurator` profile is pinned to `openai-codex` / `gpt-5.5`, has no
  provider fallback chain, and exposes only the `file` toolset to API-server
  Q&A turns. The Relay hard timeout is 60 seconds.
- The `calendarassistant` profile is pinned to `openai-codex` / `gpt-5.5`, has
  no provider fallback chain or tools, and receives a bounded structured
  context containing the parsed range, exact facts, at most 6 relevant records,
  and at most 6 bounded Calendar-only recent turns.
- Wiki evidence uses a persistent 1024-dimensional `bge-m3` vector index.
  Changed or missing notes are embedded in batches of at most 64.
- Calendar evidence uses a separate persistent `bge-m3` vector index. Exact
  date/title/time lookups bypass semantic search and use `exact-filter`.
- Wiki `bge-m3` requests use `keep_alive: 0`; Calendar `bge-m3` requests keep
  only the embedding model warm for 24 hours. The Relay does not load or warm a
  local Calendar generation model.

## Verification

Run the Relay suite on the Mac mini:

```sh
cd /Users/goyunseo/.hermes/os-runtime
HOME=/Users/goyunseo /opt/homebrew/bin/node --check scripts/hermes-railway-relay-bridge.js
HOME=/Users/goyunseo /opt/homebrew/bin/node --test tests/railway-relay-profile-chat.test.js
```

Expected live metadata for a wiki turn:

```json
{
  "answerMode": "llm",
  "llm": { "provider": "openai-codex", "model": "gpt-5.5" },
  "retrieval": {
    "source": "wiki-vector-index",
    "mode": "vector-hybrid",
    "embeddingModel": "bge-m3",
    "indexComplete": true
  }
}
```

Expected live metadata for a calendar turn:

```json
{
  "answerMode": "llm",
  "llm": {
    "provider": "openai-codex",
    "model": "gpt-5.5",
    "used": true,
    "agent": "calendarassistant"
  },
  "search": { "embeddingModel": "bge-m3" }
}
```

## Rollback

1. Replace the active Relay script and test with the matching adjacent backup.
2. Replace the `wikicurator` SOUL/config and `calendarassistant` profile config
   plus LaunchAgent plists with the matching timestamped backups.
3. Restart `ai.hermes.gateway-wikicurator`,
   `ai.hermes.gateway-calendarassistant`, and
   `com.yunseo.hermes-railway-relay` with `launchctl kickstart -k`.
4. Confirm the public path returns an explicit degraded response; never expose
   raw prompts or keyword results as a curator answer.
